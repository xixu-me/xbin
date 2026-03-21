/**
 * Shared types for encrypted payloads, storage rows, and background workflow messages.
 */
import type { ExpireKey } from './config';

export type PasteStatus = 'active' | 'claimed' | 'burned' | 'expired' | 'deleted';
export type CipherSpec = [string, string, number, number, number, string, string, string];
export type PasteEnvelopeAdata = [CipherSpec | null, string?, number?, number?];
export type CommentEnvelopeAdata = CipherSpec;
export type EnvelopeAdata = PasteEnvelopeAdata | CommentEnvelopeAdata;

export interface CipherEnvelope {
	v: number;
	adata: EnvelopeAdata;
	ct: string;
	meta?: Record<string, unknown>;
	attachment?: CipherEnvelope;
	attachment_name?: CipherEnvelope;
	pasteid?: string;
	parentid?: string;
	parentId?: string;
	comments?: CommentResponse[];
}

export interface PasteRow {
	id: string;
	schema_version: number;
	blob_key: string;
	created_at: number;
	expire_at: number | null;
	status: PasteStatus;
	burn_after_reading: number;
	discussion_open: number;
	formatter: string;
	has_attachment: number;
	delete_token_hash: string;
	claim_token_hash: string | null;
	claim_expires_at: number | null;
	comment_count: number;
	size_bytes: number;
	import_source: string | null;
	metadata_json: string | null;
}

export interface CommentRow {
	id: string;
	paste_id: string;
	parent_id: string;
	blob_key: string;
	created_at: number;
	size_bytes: number;
}

export interface CommentResponse extends CipherEnvelope {
	id: string;
	parentId: string;
	createdAt: number;
}

export interface ImportedCommentEnvelope extends CipherEnvelope {
	id: string;
}

export interface CreatePasteInput {
	envelope: CipherEnvelope;
	expireKey: ExpireKey;
	turnstileToken: string | null;
}

export interface CreateCommentInput {
	envelope: CipherEnvelope;
	parentId: string;
	turnstileToken: string | null;
}

export interface GcMessage {
	pasteId: string;
	finalStatus: Extract<PasteStatus, 'expired' | 'deleted' | 'burned'>;
}

export interface BurnClaimResult {
	ok: boolean;
	claimToken?: string;
	message?: string;
}

export interface BurnConsumeResult {
	ok: boolean;
	message?: string;
}

export interface PrivateBinImportBundle {
	pasteId: string;
	paste: CipherEnvelope;
	comments?: ImportedCommentEnvelope[];
	source?: string;
}

export interface PrivateBinImportResult {
	id: string;
	deleteToken?: string;
	importedComments: number;
	skipped: boolean;
	status: 'active' | 'expired';
}
