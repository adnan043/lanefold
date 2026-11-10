/** The quick-pick reactions shared by chat messages and card comments (the server accepts any single emoji). */
export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '🙏', '👎', '👏', '🔥', '🚀', '✅', '👀', '😀', '😍', '🤔', '😅', '😢', '😡', '💯', '💡', '⭐', '🙌', '🤝', '🐛'];

/** One emoji on a message or comment: how many people, and whether I am one of them. */
export type ReactionT = {emoji: string; count: number; mine: boolean};
