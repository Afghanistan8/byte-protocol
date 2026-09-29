/**
 * @byte-protocol/adapter-mcp
 *
 * Gate an MCP tool behind a Byte payment, and settle one from the client. Payments ride in
 * `_meta`, MCP's extension point, so a paid tool's input schema stays its own.
 */

export * from "./gate.js";
export * from "./client.js";
