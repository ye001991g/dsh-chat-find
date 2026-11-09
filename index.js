/**
 * Host half of the `@local/dsh-chat-find` bundle.
 *
 * Deliberately empty. This plugin renders in the browser and reads the
 * already-rendered transcript through its stable anchor attributes, so it
 * needs no service, no RPC, and no session-log access. Keeping the Host half
 * inert means the plugin cannot affect model requests, the session log, or
 * startup cost — it only contributes one header control in the Web UI.
 *
 * @module @local/dsh-chat-find
 */

/**
 * Host plugin entry point. Registers nothing on purpose.
 */
export function apply() {}
