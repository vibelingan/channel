import { type Locator, expect } from '@playwright/test';

/** Browser selectionchange is asynchronous; wait for Tiptap to observe the real cursor before typing. */
export async function appendArticleParagraph(editor: Locator, text: string) {
  const end = await editor.evaluate(() =>
    navigator.platform.startsWith('Mac') ? 'Meta+ArrowDown' : 'Control+End',
  );
  await editor.press(end);
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const { state } = Reflect.get(element, 'editor');
        return (
          state.selection.empty &&
          state.selection.from === state.doc.content.size - 1 &&
          state.selection.$from.parent.type.name === 'paragraph'
        );
      }),
    )
    .toBe(true);
  const paragraphs = await editor.locator('p').count();
  await editor.press('Enter');
  await expect(editor.locator('p')).toHaveCount(paragraphs + 1);
  await editor.pressSequentially(text);
  await expect(editor.locator('p').last()).toHaveText(text);
}
