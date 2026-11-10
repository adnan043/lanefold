export type EmailStatus = 'queued' | 'sent' | 'failed' | 'not_configured';
export type EmailPreview = {subject: string; text: string; configured: boolean};
