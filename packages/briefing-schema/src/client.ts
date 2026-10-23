/**
 * Browser-safe entry point (`@cerebro/briefing-schema/client`): everything in
 * the package except `documentDigest`, which depends on `node:crypto`.
 * Import from here in client components.
 */
export * from "./document";
export * from "./ids";
export * from "./gaps";
export * from "./validate";
export * from "./publish";
export * from "./diff";
export * from "./handoff";
export * from "./markdown";
export * from "./json-schema";
export * from "./fixtures/strategy-briefing";
