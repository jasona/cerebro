/**
 * Briefings: creation, drafts with lock_version, evidence approval, home move
 * vs audience change, metadata, revisions, revision documents and diff, grants.
 *
 * Every exported service takes `(db, ctx, input)` and opens its own
 * withAuthContext transaction; each has an `*InTx(tx, ctx, input)` variant for
 * composing several operations in one transaction (e.g. the MCP operation
 * runner). Mutations accept `{ operation }`, a hook called inside the
 * transaction with the result so idempotency records commit atomically.
 *
 * Named readers (AudienceSpec.readerUserIds) become reader grants
 * immediately, at create or audience-change time, not at publication. Grants
 * only ever authorize published content, so nothing is readable before
 * release, and the publication preview snapshots the active reader grants as
 * part of the reviewed audience (any grant change makes the preview stale).
 */
export {
  createBriefing,
  createBriefingInTx,
  getDraft,
  getDraftInTx,
  updateDraft,
  updateDraftInTx,
  setEvidenceStatus,
  setEvidenceStatusInTx,
  moveBriefingHome,
  moveBriefingHomeInTx,
  changeAudience,
  changeAudienceInTx,
  CreateBriefingInput,
  UpdateDraftInput,
  SetEvidenceStatusInput,
  MoveBriefingHomeInput,
  ChangeAudienceInput,
  DraftPatchOp,
  type CreateBriefingResult,
  type DraftDTO,
  type DraftEvidenceDTO,
  type UpdateDraftResult,
  type MoveBriefingHomeResult,
  type ChangeAudienceResult,
} from "./drafts";
export {
  getBriefingMeta,
  getBriefingMetaInTx,
  listRevisions,
  listRevisionsInTx,
  getRevisionDocument,
  getRevisionDocumentInTx,
  compareRevisions,
  compareRevisionsInTx,
  GetRevisionDocumentInput,
  CompareRevisionsInput,
  type BriefingMetaDTO,
  type CurrentPublicationDTO,
  type RevisionSummaryDTO,
  type RevisionInfoDTO,
  type RevisionDocumentDTO,
  type ReaderEvidenceDTO,
  type CompareRevisionsResult,
} from "./reading";
export {
  listAccess,
  listAccessInTx,
  grantAccess,
  grantAccessInTx,
  revokeGrant,
  revokeGrantInTx,
  GrantAccessInput,
  RevokeGrantInput,
  GRANTABLE_ROLES,
  type GrantableRole,
  type GrantDTO,
  type AccessListDTO,
} from "./grants";
export {
  AudienceSpec,
  HomeSpec,
  BriefingLocator,
  type HomeDTO,
  type AudienceDTO,
  type OrgUnitRef,
  type UserRef,
  type ServiceOptions,
  type ServiceOperationHook,
} from "./shared";
