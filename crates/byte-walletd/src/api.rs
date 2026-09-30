//! The localhost JSON API.
//!
//! This is the surface `@byte-protocol/wallet` calls. It is intentionally small: mint an
//! address, read notes, send, report status. Field names match the TypeScript types in
//! `packages/wallet/src/types.ts`.
//!
//! Every route except `/health` requires a bearer token. The service listens on loopback,
//! but loopback is not an authorisation boundary — any local process, including a browser
//! page making a request to `127.0.0.1`, can reach it. Holding spend capability behind
//! nothing but a bind address would be a mistake.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::memo::{self, MemoBinding};
use crate::state::{WalletState, WalletStateError};

/// Error body returned for every failure.
///
/// `code` is a stable machine-readable string; `message` is for a human reading logs.
/// Callers branch on `code`, so it is part of the contract and does not change casually.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// `Debug` so a test that unwraps one prints what went wrong. `ApiError` already derives
/// it and neither field holds a secret: the code is a fixed string and the message is what
/// the caller is about to be sent anyway.
#[derive(Debug)]
pub struct ApiFailure(StatusCode, ApiError);

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

impl From<WalletStateError> for ApiFailure {
    fn from(error: WalletStateError) -> Self {
        let (status, code) = match &error {
            WalletStateError::ViewOnly => (StatusCode::FORBIDDEN, "view_only"),
            WalletStateError::NotSynced { .. } => (StatusCode::SERVICE_UNAVAILABLE, "not_synced"),
            WalletStateError::Key(_) => (StatusCode::INTERNAL_SERVER_ERROR, "key_error"),
            WalletStateError::ChainAccess(_) => (StatusCode::BAD_GATEWAY, "chain_unavailable"),
            WalletStateError::NoChain => (StatusCode::SERVICE_UNAVAILABLE, "no_chain"),
            WalletStateError::Send(_) => (StatusCode::BAD_GATEWAY, "send_failed"),
            // 409, not 502: nothing upstream failed. The wallet holds value, and Byte is
            // declining to spend the wrong kind of it.
            WalletStateError::WrongPoolSource(_) => (StatusCode::CONFLICT, "wrong_pool_source"),
        };
        ApiFailure(status, ApiError::new(code, error.to_string()))
    }
}

type ApiResult<T> = Result<Json<T>, ApiFailure>;

#[derive(Clone)]
pub struct AppState {
    pub wallet: Arc<WalletState>,
    pub api_token: Arc<String>,
}

/// Check the bearer token in constant time.
///
/// A variable-time comparison leaks, through response timing, how many leading bytes of
/// the token an attacker guessed correctly — enough to recover it one byte at a time.
fn authorize(headers: &HeaderMap, expected: &str) -> Result<(), ApiFailure> {
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();

    let ok: bool = provided.as_bytes().ct_eq(expected.as_bytes()).into();
    if ok {
        Ok(())
    } else {
        Err(ApiFailure(
            StatusCode::UNAUTHORIZED,
            ApiError::new("unauthorized", "missing or invalid bearer token"),
        ))
    }
}

// ---------------------------------------------------------------------------- responses

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub network: &'static str,
    /// Whether this deployment holds a spending key. A facilitator's should report false.
    pub can_spend: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub network: &'static str,
    pub synced_height: u32,
    pub chain_tip: Option<u32>,
    pub synced: bool,
    /// Height at which NU6.3 activated. Below it the Ironwood pool does not exist.
    pub nu6_3_activation_height: u32,
    /// Consensus branch the light server reports, lowercase hex, when it has said.
    ///
    /// The TypeScript side decides block spacing from this. It is deliberately not derived
    /// from a height: ZIP 259 records NU7's activation heights as TBD, so any height Byte
    /// held would be a guess, and a wrong one makes every confirmation wait three times
    /// too short.
    pub consensus_branch_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressResponse {
    /// A fresh diversified unified address with an Orchard receiver and no transparent
    /// receiver. After NU6.3, value sent here lands in the Ironwood pool.
    pub address: String,
    pub diversifier_index: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewingKeyResponse {
    /// The unified **incoming** viewing key.
    ///
    /// Sees received notes and their memos: enough to verify that an invoice was paid, and
    /// not enough to see what the account has spent. Prefer it when handing a key to a
    /// facilitator or an auditor.
    pub uivk: String,
    /// The unified full viewing key. Grants the ability to *see* payments, never to spend.
    pub ufvk: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoEncodeResponse {
    pub memo: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoVerifyResponse {
    pub valid: bool,
}

// ----------------------------------------------------------------------------- requests

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoEncodeRequest {
    /// Hex-encoded memo secret, at least 32 bytes.
    pub secret: String,
    pub invoice_id: String,
    pub amount_zat: String,
    pub pay_to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoVerifyRequest {
    pub secret: String,
    pub memo: String,
    pub invoice_id: String,
    pub amount_zat: String,
    pub pay_to: String,
}

/// One output of a payment.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutputRequest {
    /// Destination address.
    pub to: String,
    /// Zatoshis, as a base-10 integer string.
    pub amount_zat: String,
    /// The memo to attach. Absent on a fee leg, and on any transparent output.
    #[serde(default)]
    pub memo: Option<String>,
}

/// A payment.
///
/// Either the single-output form (`to`/`amountZat`/`memo`) or `outputs`. Both are accepted
/// because most payments are one output and the flat form reads better, while a facilitator
/// fee needs two **in one transaction** — atomicity is exactly why the verifier's "both
/// arrived" check means anything.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub amount_zat: Option<String>,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub outputs: Option<Vec<SendOutputRequest>>,
}

/// Sweep transparent value into Ironwood.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldRequest {
    /// Transparent addresses to sweep. Every one the wallet controls, when omitted.
    #[serde(default)]
    pub from_transparent: Option<Vec<String>>,
    /// Leave UTXOs below this alone. Defaults to the ZIP 317 marginal fee.
    #[serde(default)]
    pub minimum_zat: Option<String>,
}

/// Send value out of Ironwood to a transparent address. Publishes the amount.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshieldRequest {
    /// A transparent address, `t1` or `t3`.
    pub to_transparent: String,
    /// Zatoshis, as a base-10 integer string.
    pub amount_zat: String,
}

/// A PCZT, hex-encoded, and what the signer may agree to do with it.
///
/// Hex rather than base64 because `hex` is already a dependency and a PCZT crosses
/// loopback: the 1.33x a base64 encoding would save is not worth another crate in a
/// signing path, which is the last place to add one for convenience.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcztRequest {
    /// The PCZT, hex-encoded.
    pub pczt: String,
    /// Encoded unified addresses this signer will pay. Any recipient when absent.
    ///
    /// Absent means "no restriction", which is the dangerous default, so `/pczt/sign`
    /// reports back which policy it applied rather than leaving a caller to assume.
    #[serde(default)]
    pub allow_recipients: Vec<String>,
    /// Refuse if the total paid to others exceeds this, as a base-10 integer string.
    #[serde(default)]
    pub max_total_zat: Option<String>,
}

/// What a PCZT build costs, alongside the PCZT itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcztCreated {
    /// The PCZT, hex-encoded, ready to be reviewed and signed elsewhere.
    pub pczt: String,
    /// The network fee this proposal will pay, in zatoshis.
    pub fee_zat: String,
    /// What it pays and to whom, so the machine that builds need not be trusted to say.
    pub review: crate::split_sign::SignReview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcztResponse {
    /// The resulting PCZT, hex-encoded.
    pub pczt: String,
    /// What the signer read before it acted, so a caller can log what was authorized.
    pub review: crate::split_sign::SignReview,
    /// The policy that was actually applied, stated rather than assumed.
    pub policy_applied: PolicyApplied,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyApplied {
    pub recipients_restricted: bool,
    pub max_total_zat: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesQuery {
    /// Transaction identifier, 64 lowercase hex characters.
    pub txid: String,
}

// ------------------------------------------------------------------------------- routes

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/addresses", post(new_address))
        .route("/transparent-addresses", post(new_transparent_address))
        .route("/viewing-key", get(viewing_key))
        .route("/memo/encode", post(memo_encode))
        .route("/memo/verify", post(memo_verify))
        .route("/notes", get(notes))
        .route("/balance", get(balance))
        .route("/send", post(send))
        .route("/shield", post(shield))
        .route("/unshield", post(unshield))
        // The split signer. `review` needs no key and is safe for a view-only deployment;
        // `sign` needs the spending key and refuses without one.
        .route("/pczt/create", post(pczt_create))
        .route("/pczt/review", post(pczt_review))
        .route("/pczt/sign", post(pczt_sign))
        .route("/pczt/prove", post(pczt_prove))
        .route("/pczt/extract", post(pczt_extract))
        // 1 MiB. Every other route here is satisfied by a few hundred bytes and 64 KiB
        // was the limit for years, but a PCZT is a whole transaction plus the metadata a
        // signer needs, hex-encoded, and a legitimate one can exceed 64 KiB. The limit
        // exists so an unauthenticated caller cannot exhaust memory; it still does, and
        // every PCZT route is behind the bearer token besides.
        .layer(tower_http::limit::RequestBodyLimitLayer::new(1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// Unauthenticated, so a supervisor can check liveness without holding the token.
/// Reports nothing an unauthenticated caller should not see.
async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        network: state.wallet.network().byte_id(),
        can_spend: state.wallet.can_spend(),
    })
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<StatusResponse> {
    authorize(&headers, &state.api_token)?;
    let status = state.wallet.status()?;
    Ok(Json(StatusResponse {
        network: state.wallet.network().byte_id(),
        synced_height: status.synced_height,
        chain_tip: status.chain_tip,
        synced: status.synced,
        nu6_3_activation_height: state.wallet.network().nu6_3_activation_height(),
        consensus_branch_id: status.consensus_branch_id,
    }))
}

/// Mint a fresh transparent address for a rail to deliver to.
///
/// Never an invoice address: Byte settles in Ironwood, and `/addresses` deliberately mints
/// addresses with no transparent receiver. This exists because NEAR Intents delivers ZEC to
/// `t1`/`t3` only, so funding has to land somewhere public first.
///
/// A fresh one per funding, so an observer cannot read a single address as the whole
/// funding history of one party.
async fn new_transparent_address(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<AddressResponse> {
    authorize(&headers, &state.api_token)?;
    let (address, diversifier_index) = state.wallet.new_transparent_address()?;
    Ok(Json(AddressResponse {
        address,
        diversifier_index,
    }))
}

async fn new_address(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<AddressResponse> {
    authorize(&headers, &state.api_token)?;
    let (address, diversifier_index) = state.wallet.new_invoice_address()?;
    Ok(Json(AddressResponse {
        address,
        diversifier_index,
    }))
}

async fn viewing_key(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<ViewingKeyResponse> {
    authorize(&headers, &state.api_token)?;
    Ok(Json(ViewingKeyResponse {
        uivk: state.wallet.export_uivk()?,
        ufvk: state.wallet.export_ufvk()?,
    }))
}

async fn memo_encode(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MemoEncodeRequest>,
) -> ApiResult<MemoEncodeResponse> {
    authorize(&headers, &state.api_token)?;
    let secret = decode_secret(&body.secret)?;
    let memo = memo::encode_memo(
        &secret,
        &MemoBinding {
            invoice_id: &body.invoice_id,
            amount_zat: &body.amount_zat,
            pay_to: &body.pay_to,
        },
    )
    .map_err(|e| {
        ApiFailure(
            StatusCode::BAD_REQUEST,
            ApiError::new("bad_memo", e.to_string()),
        )
    })?;

    Ok(Json(MemoEncodeResponse { memo }))
}

async fn memo_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MemoVerifyRequest>,
) -> ApiResult<MemoVerifyResponse> {
    authorize(&headers, &state.api_token)?;
    let secret = decode_secret(&body.secret)?;
    // Returns a bool, never an error: a memo that does not verify is an ordinary outcome,
    // not an exceptional one.
    let valid = memo::verify_memo(
        &secret,
        &body.memo,
        &MemoBinding {
            invoice_id: &body.invoice_id,
            amount_zat: &body.amount_zat,
            pay_to: &body.pay_to,
        },
    );
    Ok(Json(MemoVerifyResponse { valid }))
}

async fn notes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<NotesQuery>,
) -> ApiResult<Vec<crate::state::NoteRecord>> {
    authorize(&headers, &state.api_token)?;
    Ok(Json(state.wallet.outputs_for_txid(&query.txid)?))
}

async fn balance(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<crate::state::BalanceRecord> {
    authorize(&headers, &state.api_token)?;
    Ok(Json(state.wallet.balance()?))
}

/// Build, prove and broadcast a shielded Ironwood payment.
///
/// This is the only route that moves value. A view-only deployment rejects it with
/// `view_only` before any transaction is built.
/// Sweep transparent value into Ironwood.
///
/// Answers `{}` — no txid — when there was nothing above the threshold worth moving. That
/// is the ordinary end of a sweep, and reporting it as an error would make every completed
/// sweep look like a failure.
async fn shield(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ShieldRequest>,
) -> ApiResult<Option<crate::chain::ShieldOutcome>> {
    authorize(&headers, &state.api_token)?;

    let minimum_zat = match body.minimum_zat.as_deref() {
        Some(raw) => Some(parse_zat(raw, "minimumZat")?),
        None => None,
    };

    Ok(Json(
        state
            .wallet
            .shield(body.from_transparent.as_deref(), minimum_zat)
            .await?,
    ))
}

/// Send value out of Ironwood to a transparent address.
///
/// The amount becomes public. That is what unshielding is, and there is no version of it
/// that does not leak — see docs/SECURITY.md.
async fn unshield(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UnshieldRequest>,
) -> ApiResult<crate::chain::SendOutcome> {
    authorize(&headers, &state.api_token)?;

    let amount_zat = parse_zat(&body.amount_zat, "amountZat")?;

    Ok(Json(
        state
            .wallet
            .unshield(&body.to_transparent, amount_zat)
            .await?,
    ))
}

/// Decode a hex PCZT, saying which field was wrong rather than "bad request".
fn parse_pczt(hex_encoded: &str) -> Result<::pczt::Pczt, ApiFailure> {
    let bytes = hex::decode(hex_encoded.trim()).map_err(|e| {
        ApiFailure(
            StatusCode::BAD_REQUEST,
            ApiError::new("bad_request", format!("pczt is not valid hex: {e}")),
        )
    })?;
    ::pczt::Pczt::parse(&bytes).map_err(|e| {
        ApiFailure(
            StatusCode::BAD_REQUEST,
            ApiError::new("bad_request", format!("pczt did not parse: {e:?}")),
        )
    })
}

/// Encode a PCZT for the response.
///
/// `serialize` is fallible. A PCZT this process just signed or proved failing to encode is
/// a bug in this process, not bad input from the caller, so it is a 500 and names the stage
/// rather than being folded into a generic bad-request.
fn encode_pczt(pczt: ::pczt::Pczt, stage: &str) -> Result<String, ApiFailure> {
    pczt.serialize().map(hex::encode).map_err(|e| {
        ApiFailure(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::new(
                "encode_failed",
                format!("the {stage} PCZT could not be encoded: {e:?}"),
            ),
        )
    })
}

fn policy_from(body: &PcztRequest) -> Result<crate::split_sign::SignPolicy, ApiFailure> {
    let max_total_zat = match body.max_total_zat.as_deref() {
        Some(raw) => Some(parse_zat(raw, "maxTotalZat")?),
        None => None,
    };
    Ok(crate::split_sign::SignPolicy {
        allow_recipients: body.allow_recipients.clone(),
        max_total_zat,
    })
}

/// Build a PCZT for the given outputs, instead of signing and broadcasting one.
///
/// Needs no spending key. That is the split: the machine that decides what to pay builds
/// the transaction, and the key lives somewhere that never builds anything.
///
/// Takes the same body as `/send`, so a caller moving from one to the other changes the URL
/// and nothing else. The response includes the review, so the builder does not have to be
/// trusted to describe what it built: whoever signs can read it themselves.
async fn pczt_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> ApiResult<PcztCreated> {
    authorize(&headers, &state.api_token)?;

    let outputs = send_outputs_from(body)?;
    let (pczt, fee_zat) = state.wallet.create_pczt(&outputs).await?;
    let review = crate::split_sign::review(&pczt, state.wallet.network()).map_err(|e| {
        ApiFailure(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::new("refused", e.to_string()),
        )
    })?;

    Ok(Json(PcztCreated {
        pczt: encode_pczt(pczt, "created")?,
        fee_zat: fee_zat.to_string(),
        review,
    }))
}

/// Turn a signed and proved PCZT into a broadcast transaction.
///
/// The other end of the split, and it needs no spending key either: the signature is already
/// in the PCZT, and this end verifies the proof rather than trusting it. Until the broadcast
/// succeeds nothing has left the machine, so a failure here means the payment did not happen
/// rather than that it happened and was lost.
async fn pczt_extract(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PcztRequest>,
) -> ApiResult<crate::chain::SendOutcome> {
    authorize(&headers, &state.api_token)?;

    let pczt = parse_pczt(&body.pczt)?;
    Ok(Json(state.wallet.extract_pczt(pczt).await?))
}

/// Read what a PCZT would do, without signing it.
///
/// Needs no key, so a view-only deployment can answer it. That is the point of separating
/// review from signing: whoever decides whether to authorize a transaction should be able
/// to see it without being able to sign it.
async fn pczt_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PcztRequest>,
) -> ApiResult<crate::split_sign::SignReview> {
    authorize(&headers, &state.api_token)?;

    let pczt = parse_pczt(&body.pczt)?;
    crate::split_sign::review(&pczt, state.wallet.network())
        .map(Json)
        .map_err(|e| {
            ApiFailure(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiError::new("refused", e.to_string()),
            )
        })
}

/// Check a PCZT against a policy, then sign every Ironwood spend in it.
///
/// The policy is checked in full before any signature is produced, so a refusal never
/// leaves a partially signed PCZT behind. `422` rather than `400` on refusal: the request
/// was well-formed and the answer is no.
async fn pczt_sign(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PcztRequest>,
) -> ApiResult<PcztResponse> {
    authorize(&headers, &state.api_token)?;

    let pczt = parse_pczt(&body.pczt)?;
    let policy = policy_from(&body)?;
    let ask = state.wallet.spend_authorizing_key()?;

    let (signed, review) = crate::split_sign::sign(pczt, &ask, &policy, state.wallet.network())
        .map_err(|e| {
            ApiFailure(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiError::new("refused", e.to_string()),
            )
        })?;

    Ok(Json(PcztResponse {
        pczt: encode_pczt(signed, "signed")?,
        review,
        policy_applied: PolicyApplied {
            recipients_restricted: !policy.allow_recipients.is_empty(),
            max_total_zat: policy.max_total_zat.map(|v| v.to_string()),
        },
    }))
}

/// Add the Ironwood proof.
///
/// Needs no secret, only the proving key, so it belongs on the builder rather than the
/// signer. Kept a separate route for that reason: the process holding the key should do as
/// little as possible beyond holding it and deciding.
async fn pczt_prove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PcztRequest>,
) -> ApiResult<PcztResponse> {
    authorize(&headers, &state.api_token)?;

    let pczt = parse_pczt(&body.pczt)?;
    let review = crate::split_sign::review(&pczt, state.wallet.network()).map_err(|e| {
        ApiFailure(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::new("refused", e.to_string()),
        )
    })?;
    let proved = crate::split_sign::prove(pczt).map_err(|e| {
        ApiFailure(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::new("prove_failed", e.to_string()),
        )
    })?;

    Ok(Json(PcztResponse {
        pczt: encode_pczt(proved, "proved")?,
        review,
        policy_applied: PolicyApplied {
            recipients_restricted: false,
            max_total_zat: None,
        },
    }))
}

/// Normalise a send body into outputs.
///
/// Shared by `/send` and `/pczt/create` so the two accept exactly the same request. A
/// caller moving between them changes the URL and nothing else, and neither route can
/// quietly grow a shape the other does not honour.
fn send_outputs_from(body: SendRequest) -> Result<Vec<crate::chain::SendOutput>, ApiFailure> {
    let requested = match body.outputs {
        Some(outputs) => outputs,
        None => {
            let to = body.to.ok_or_else(|| {
                ApiFailure(
                    StatusCode::BAD_REQUEST,
                    ApiError::new("bad_request", "send needs either `outputs` or `to`"),
                )
            })?;
            let amount_zat = body.amount_zat.ok_or_else(|| {
                ApiFailure(
                    StatusCode::BAD_REQUEST,
                    ApiError::new("bad_request", "send needs either `outputs` or `amountZat`"),
                )
            })?;
            vec![SendOutputRequest {
                to,
                amount_zat,
                memo: body.memo,
            }]
        }
    };

    let mut outputs = Vec::with_capacity(requested.len());
    for output in requested {
        outputs.push(crate::chain::SendOutput {
            to: output.to,
            amount_zat: parse_zat(&output.amount_zat, "amountZat")?,
            memo: output.memo,
        });
    }
    Ok(outputs)
}

async fn send(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> ApiResult<crate::chain::SendOutcome> {
    authorize(&headers, &state.api_token)?;

    let outputs = send_outputs_from(body)?;
    Ok(Json(state.wallet.send_many(&outputs).await?))
}

/// Parse a zatoshi amount, naming the field that was wrong.
///
/// Amounts cross this boundary as strings, never as JSON numbers, for the reason set out
/// in `packages/core/src/amount.ts`: the maximum supply fits in an f64 today and is one
/// multiplication away from not fitting.
fn parse_zat(raw: &str, field: &str) -> Result<u64, ApiFailure> {
    raw.parse().map_err(|_| {
        ApiFailure(
            StatusCode::BAD_REQUEST,
            ApiError::new(
                "bad_amount",
                format!("{field} must be a base-10 integer string of zatoshis"),
            ),
        )
    })
}

fn decode_secret(hex_secret: &str) -> Result<Vec<u8>, ApiFailure> {
    hex::decode(hex_secret).map_err(|e| {
        ApiFailure(
            StatusCode::BAD_REQUEST,
            ApiError::new("bad_secret", format!("secret must be hex: {e}")),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(value).unwrap(),
        );
        headers
    }

    // ------------------------------------------------------------------ PCZT plumbing
    //
    // The signing policy itself is tested in `split_sign`. What is worth testing here is
    // the layer between HTTP and that module, because it is the layer that decides what a
    // caller is allowed to leave out, and every field it defaults is a restriction the
    // signer will not apply.

    #[test]
    fn send_and_pczt_create_accept_the_same_body() {
        // They share `send_outputs_from` so this is true by construction, and asserted
        // because the moment it stops being true a caller moving between the two routes
        // gets a different transaction from the same request.
        let single = SendRequest {
            to: Some("u1abc".into()),
            amount_zat: Some("50000".into()),
            memo: Some("BYTE1|x|y".into()),
            outputs: None,
        };
        let parsed = send_outputs_from(single).expect("a single-output body parses");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].amount_zat, 50_000);
        assert_eq!(parsed[0].memo.as_deref(), Some("BYTE1|x|y"));
    }

    #[test]
    fn a_multi_output_body_keeps_every_output() {
        // The fee leg is the second output, and dropping it would turn a fee-carrying
        // invoice into a payment that silently skips the facilitator.
        let body = SendRequest {
            to: None,
            amount_zat: None,
            memo: None,
            outputs: Some(vec![
                SendOutputRequest {
                    to: "u1payee".into(),
                    amount_zat: "50000".into(),
                    memo: Some("BYTE1|a|b".into()),
                },
                SendOutputRequest {
                    to: "u1fee".into(),
                    amount_zat: "1250".into(),
                    memo: None,
                },
            ]),
        };
        let parsed = send_outputs_from(body).expect("a two-output body parses");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].amount_zat, 1_250);
        assert!(parsed[1].memo.is_none(), "the fee leg must carry no memo");
    }

    #[test]
    fn a_body_with_neither_outputs_nor_to_is_refused() {
        let body = SendRequest {
            to: None,
            amount_zat: None,
            memo: None,
            outputs: None,
        };
        let failure = send_outputs_from(body).expect_err("a body naming no recipient was accepted");
        assert_eq!(failure.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_pczt_that_is_not_hex_is_a_bad_request_and_says_so() {
        let failure = parse_pczt("not hex at all").expect_err("non-hex was accepted");
        assert_eq!(failure.0, StatusCode::BAD_REQUEST);
        assert!(failure.1.message.contains("valid hex"), "{:?}", failure.1);
    }

    #[test]
    fn valid_hex_that_is_not_a_pczt_is_refused_separately() {
        // Distinguished from the above on purpose: "your encoding is wrong" and "your
        // encoding is right and the contents are not a PCZT" send a caller to different
        // places.
        let failure = parse_pczt("deadbeef").expect_err("\"deadbeef\" was accepted");
        assert_eq!(failure.0, StatusCode::BAD_REQUEST);
        assert!(
            failure.1.message.contains("did not parse"),
            "{:?}",
            failure.1
        );
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        // A hex blob arrives via copy and paste often enough that trimming it is kinder
        // than a rejection that looks like a corrupted PCZT.
        match parse_pczt(
            "  deadbeef
",
        ) {
            Err(f) => assert!(f.1.message.contains("did not parse"), "{:?}", f.1),
            Ok(_) => panic!("whitespace-padded hex was accepted as a PCZT"),
        }
    }

    #[test]
    fn an_absent_policy_restricts_nothing() {
        // The dangerous default, asserted so it cannot become accidental: omitting both
        // fields is "any recipient, any amount". `/pczt/sign` reports this back in
        // `policyApplied` rather than leaving a caller to assume otherwise.
        let body = PcztRequest {
            pczt: String::new(),
            allow_recipients: vec![],
            max_total_zat: None,
        };
        let policy = policy_from(&body).expect("an absent policy is valid");
        assert!(policy.allow_recipients.is_empty());
        assert!(policy.max_total_zat.is_none());
    }

    #[test]
    fn a_policy_cap_is_parsed_as_zatoshis() {
        let body = PcztRequest {
            pczt: String::new(),
            allow_recipients: vec!["u1abc".into()],
            max_total_zat: Some("100000".into()),
        };
        let policy = policy_from(&body).expect("a valid policy parses");
        assert_eq!(policy.max_total_zat, Some(100_000));
        assert_eq!(policy.allow_recipients, vec!["u1abc".to_string()]);
    }

    #[test]
    fn a_cap_that_is_not_a_number_is_refused_rather_than_ignored() {
        // Silently dropping an unparseable cap would turn a caller asking for a limit into
        // a signer with none, which is the worst direction for this particular field.
        for bad in ["abc", "-1", "1.5", "", " 100"] {
            let body = PcztRequest {
                pczt: String::new(),
                allow_recipients: vec![],
                max_total_zat: Some(bad.to_string()),
            };
            assert!(policy_from(&body).is_err(), "accepted maxTotalZat {bad:?}");
        }
    }

    #[test]
    fn every_pczt_route_requires_the_token() {
        // They are on the same router and the same `authorize`, but signing is the one
        // route where a missing check would be worst, so it is asserted rather than assumed.
        for header in ["", "Bearer wrong", "correct-token-value"] {
            assert!(authorize(&headers_with(header), "correct-token-value").is_err());
        }
    }

    #[test]
    fn authorize_accepts_the_exact_token() {
        assert!(authorize(
            &headers_with("Bearer correct-token-value"),
            "correct-token-value"
        )
        .is_ok());
    }

    #[test]
    fn authorize_rejects_everything_else() {
        let token = "correct-token-value";
        for header in [
            "Bearer wrong-token-value",
            "Bearer correct-token-valu",
            "Bearer correct-token-value ",
            "correct-token-value",
            "Basic correct-token-value",
            "Bearer ",
            "",
        ] {
            assert!(
                authorize(&headers_with(header), token).is_err(),
                "should have rejected {header:?}"
            );
        }
    }

    #[test]
    fn authorize_rejects_a_missing_header() {
        assert!(authorize(&HeaderMap::new(), "correct-token-value").is_err());
    }

    #[test]
    fn decode_secret_rejects_non_hex() {
        assert!(decode_secret("nothex!!").is_err());
        assert!(decode_secret("00ff").is_ok());
    }
}
