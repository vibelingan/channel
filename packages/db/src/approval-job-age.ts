/**
 * An approval finishes within an hour of its first step, or never (DEC-21):
 * finishStagedApproval refuses an older job. Photo deletes then stop treating
 * the job as running (unfinishedApprovalUsingImage), so an abandoned or failed
 * attempt cannot pin its photos for good.
 */
export const APPROVAL_JOB_MAX_AGE_MS = 60 * 60 * 1000;

/** Far longer than any open transaction: a finish that passed the age check has committed. */
export const APPROVAL_JOB_DELETE_MARGIN_MS = 10 * 60 * 1000;

/** Bound differences between trusted catalog service timestamps; past expiry stays strict. */
export const CATALOG_CLOCK_SKEW_MS = 5_000;
