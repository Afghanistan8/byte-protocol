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
        .route("/viewing-key", get(viewing_key))
        .route("/memo/encode", post(memo_encode))
        .route("/memo/verify", post(memo_verify))
        .route("/notes", get(notes))
        .route("/balance", get(balance))
        // 64 KiB is far above any legitimate request here and well below anything that
        // would let an unauthenticated caller exhaust memory.
        .layer(tower_http::limit::RequestBodyLimitLayer::new(64 * 1024))
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
