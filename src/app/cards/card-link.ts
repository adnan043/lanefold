/** The address that opens one card: `/app/b/<boardId>/c/<cardId>` (ids only: no title, no name, no email). */
export function cardLinkPath(boardId: number, cardId: number): string {
  return `/app/b/${boardId}/c/${cardId}`;
}

/** The absolute address of a card, for pasting into chat or an email. */
export function cardLinkUrl(origin: string, boardId: number, cardId: number): string {
  return `${origin.replace(/\/+$/, '')}${cardLinkPath(boardId, cardId)}`;
}

/** Copies the card's address; false when the browser blocks the clipboard (the caller says so in words). */
export async function copyCardLink(boardId: number, cardId: number): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(cardLinkUrl(window.location.origin, boardId, cardId));
    return true;
  } catch {
    return false;
  }
}
