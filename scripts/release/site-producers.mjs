/** Choose only a producer recorded in the reviewed policy, using authenticated GitHub run metadata. */
export function siteProducerPolicy(policy, run) {
  const workflowPath = run.workflowPath ?? run.path;
  const ref = run.ref ?? `refs/heads/${run.head_branch}`;
  const source = (
    policy.sources ?? [
      {
        workflowPath: policy.workflowPath,
        trustedRef: policy.trustedRef,
        events: ['workflow_dispatch'],
      },
    ]
  ).find(
    (source) =>
      source.workflowPath === workflowPath &&
      source.trustedRef === ref &&
      source.events.includes(run.event),
  );
  if (!source) throw Error('Unapproved site artifact producer');
  return {
    ...policy,
    workflowPath: source.workflowPath,
    trustedRef: source.trustedRef,
    events: source.events,
  };
}
