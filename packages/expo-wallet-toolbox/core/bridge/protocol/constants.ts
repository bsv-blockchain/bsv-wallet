/**
 * Admin originator constants, in a module with no imports so the Safari extension bundle (and
 * anything else that must stay free of app code) can reach them. `core/config` re-exports both.
 */

/**
 * Internal authority label passed only by the wallet shell.
 *
 * The permissions manager grants this originator administrative access, so it
 * must be a name no external caller can present. It used to sit outside the
 * hostname namespace altogether (`urn:bsv-wallet:internal-admin`), but
 * @bsv/sdk 2.8 accepts only canonical hostnames as originators. It now lives
 * in the RFC 6761 `.invalid` TLD, which never resolves, so no host can be
 * served from it, and `parseExternalOrigin` refuses that whole TLD at the
 * external trust boundary. An ordinary DNS name would let whoever controls
 * that host acquire the same authority through a paired connection.
 */
export const ADMIN_ORIGINATOR = 'internal-admin.bsv-wallet.invalid'

/** The label before @bsv/sdk 2.8, still found in data persisted by older builds. */
export const LEGACY_ADMIN_ORIGINATOR = 'urn:bsv-wallet:internal-admin'
