/** Fault injection is restricted to the article created by our real UI acceptance. Other tasks remain untouched. */
export function assertOwnedArticleDrill({ taskId, task, draft }) {
  if (
    !/^release-[a-f0-9]{64}$/.test(taskId ?? '') ||
    task?._id !== taskId ||
    task.id !== taskId ||
    task.state !== 'QUEUED' ||
    !/^oem-project-brief-acceptance-\d+$/.test(task.slug ?? '') ||
    draft?.id !== task.articleId ||
    draft.content?.slug !== task.slug ||
    draft.content?.title !== 'Preparing an OEM headphone project brief' ||
    draft.content?.authorName !== 'Diversity Technology Limited'
  )
    throw Error('Fault injection requires the exact owned acceptance article');
}
