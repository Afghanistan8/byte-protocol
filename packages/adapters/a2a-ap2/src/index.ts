/**
 * @byte-protocol/adapter-a2a-ap2
 *
 * Byte as an AP2 payment method inside a cart's W3C PaymentRequest, carried over A2A.
 *
 * This provides the payment method, not AP2's mandate chain. The merchant authorization
 * JWT, the cart hash and the Intent-to-Cart-to-Payment signing flow are AP2's own integrity
 * mechanisms. Byte answers "the payment happened, shielded, and here is proof"; it does not
 * answer "the user authorised this cart".
 */

export * from "./method.js";
export * from "./flow.js";
