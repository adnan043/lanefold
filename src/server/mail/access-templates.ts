import {clean, escapeHtml, isMailLocale, type MailLocale, type RenderedEmail} from './templates';

/**
 * "Your request to join a board was approved": subject + plain text + simple HTML, in all 20 launch languages.
 * Same safety as the invite email (templates.ts): every name goes through `clean()` (no control, line-break or bidi
 * characters, capped) and the HTML through `escapeHtml()`; names are isolated (FSI…PDI / <bdi>) so a right-to-left
 * board name cannot reorder the sentence. Names only: no address of anyone.
 *
 * REVIEW STATUS: English is final; the 19 other languages are machine drafts that need a native speaker's review
 * (needs-review), like src/i18n/messages.
 */

interface Strings {
  /** {board} */
  subject: string;
  /** {approver}, {board} */
  intro: string;
  open: string;
  noreply: string;
}

const T: Record<MailLocale, Strings> = {
  en: {
    subject: 'You can now open the board {board} on Lanefold',
    intro: '{approver} approved your request to join the board "{board}" on Lanefold.',
    open: 'Open the board:',
    noreply: 'This is an automated message. Replies are not read.',
  },
  // needs-review: every locale below.
  bn: {
    subject: 'আপনি এখন Lanefold-এ "{board}" বোর্ডটি খুলতে পারবেন',
    intro: '{approver} Lanefold-এ "{board}" বোর্ডে যোগ দেওয়ার আপনার অনুরোধ অনুমোদন করেছেন।',
    open: 'বোর্ডটি খুলুন:',
    noreply: 'এটি একটি স্বয়ংক্রিয় বার্তা। উত্তর পড়া হয় না।',
  },
  hi: {
    subject: 'अब आप Lanefold पर "{board}" बोर्ड खोल सकते हैं',
    intro: '{approver} ने Lanefold पर "{board}" बोर्ड से जुड़ने का आपका अनुरोध स्वीकार कर लिया है।',
    open: 'बोर्ड खोलें:',
    noreply: 'यह एक स्वचालित संदेश है। जवाब पढ़े नहीं जाते।',
  },
  ur: {
    subject: 'اب آپ Lanefold پر "{board}" بورڈ کھول سکتے ہیں',
    intro: '{approver} نے Lanefold پر "{board}" بورڈ میں شامل ہونے کی آپ کی درخواست منظور کر لی ہے۔',
    open: 'بورڈ کھولیں:',
    noreply: 'یہ ایک خودکار پیغام ہے۔ جوابات نہیں پڑھے جاتے۔',
  },
  ar: {
    subject: 'يمكنك الآن فتح اللوحة "{board}" على Lanefold',
    intro: 'وافق {approver} على طلبك للانضمام إلى اللوحة "{board}" على Lanefold.',
    open: 'افتح اللوحة:',
    noreply: 'هذه رسالة تلقائية. لا تتم قراءة الردود.',
  },
  fa: {
    subject: 'اکنون می‌توانید بورد "{board}" را در Lanefold باز کنید',
    intro: '{approver} درخواست شما برای پیوستن به بورد "{board}" در Lanefold را تأیید کرد.',
    open: 'بورد را باز کنید:',
    noreply: 'این یک پیام خودکار است. پاسخ‌ها خوانده نمی‌شوند.',
  },
  es: {
    subject: 'Ya puedes abrir el tablero {board} en Lanefold',
    intro: '{approver} aprobó tu solicitud para unirte al tablero "{board}" en Lanefold.',
    open: 'Abre el tablero:',
    noreply: 'Este es un mensaje automático. Las respuestas no se leen.',
  },
  fr: {
    subject: 'Vous pouvez maintenant ouvrir le tableau {board} sur Lanefold',
    intro: '{approver} a approuvé votre demande pour rejoindre le tableau « {board} » sur Lanefold.',
    open: 'Ouvrir le tableau :',
    noreply: 'Ceci est un message automatique. Les réponses ne sont pas lues.',
  },
  pt: {
    subject: 'Agora você pode abrir o quadro {board} no Lanefold',
    intro: '{approver} aprovou seu pedido para entrar no quadro "{board}" no Lanefold.',
    open: 'Abra o quadro:',
    noreply: 'Esta é uma mensagem automática. As respostas não são lidas.',
  },
  de: {
    subject: 'Du kannst jetzt das Board {board} auf Lanefold öffnen',
    intro: '{approver} hat deine Anfrage angenommen, dem Board „{board}“ auf Lanefold beizutreten.',
    open: 'Board öffnen:',
    noreply: 'Dies ist eine automatische Nachricht. Antworten werden nicht gelesen.',
  },
  it: {
    subject: 'Ora puoi aprire la bacheca {board} su Lanefold',
    intro: '{approver} ha approvato la tua richiesta di unirti alla bacheca "{board}" su Lanefold.',
    open: 'Apri la bacheca:',
    noreply: 'Questo è un messaggio automatico. Le risposte non vengono lette.',
  },
  ru: {
    subject: 'Теперь вы можете открыть доску {board} в Lanefold',
    intro: '{approver} одобрил(а) ваш запрос на доступ к доске «{board}» в Lanefold.',
    open: 'Открыть доску:',
    noreply: 'Это автоматическое сообщение. Ответы не читаются.',
  },
  tr: {
    subject: 'Artık Lanefold\'da {board} panosunu açabilirsiniz',
    intro: '{approver}, Lanefold\'daki "{board}" panosuna katılma isteğinizi onayladı.',
    open: 'Panoyu açın:',
    noreply: 'Bu otomatik bir mesajdır. Yanıtlar okunmaz.',
  },
  id: {
    subject: 'Sekarang Anda bisa membuka papan {board} di Lanefold',
    intro: '{approver} menyetujui permintaan Anda untuk bergabung ke papan "{board}" di Lanefold.',
    open: 'Buka papan:',
    noreply: 'Ini adalah pesan otomatis. Balasan tidak dibaca.',
  },
  zh: {
    subject: '您现在可以在 Lanefold 上打开看板 {board}',
    intro: '{approver} 已批准您加入 Lanefold 上的看板“{board}”的请求。',
    open: '打开看板：',
    noreply: '这是一封自动发送的邮件，回复不会被阅读。',
  },
  ja: {
    subject: 'Lanefold のボード「{board}」を開けるようになりました',
    intro: '{approver} さんが、Lanefold のボード「{board}」への参加リクエストを承認しました。',
    open: 'ボードを開く:',
    noreply: 'このメールは自動送信です。返信は読まれません。',
  },
  ko: {
    subject: '이제 Lanefold에서 {board} 보드를 열 수 있습니다',
    intro: '{approver} 님이 Lanefold의 "{board}" 보드 참여 요청을 승인했습니다.',
    open: '보드 열기:',
    noreply: '자동으로 발송된 메일입니다. 회신은 확인되지 않습니다.',
  },
  vi: {
    subject: 'Giờ bạn có thể mở bảng {board} trên Lanefold',
    intro: '{approver} đã chấp thuận yêu cầu tham gia bảng "{board}" trên Lanefold của bạn.',
    open: 'Mở bảng:',
    noreply: 'Đây là tin nhắn tự động. Thư trả lời sẽ không được đọc.',
  },
  th: {
    subject: 'ตอนนี้คุณเปิดบอร์ด {board} บน Lanefold ได้แล้ว',
    intro: '{approver} อนุมัติคำขอเข้าร่วมบอร์ด "{board}" บน Lanefold ของคุณแล้ว',
    open: 'เปิดบอร์ด:',
    noreply: 'นี่คือข้อความอัตโนมัติ จะไม่มีการอ่านข้อความตอบกลับ',
  },
  sw: {
    subject: 'Sasa unaweza kufungua ubao {board} kwenye Lanefold',
    intro: '{approver} ameidhinisha ombi lako la kujiunga na ubao "{board}" kwenye Lanefold.',
    open: 'Fungua ubao:',
    noreply: 'Huu ni ujumbe wa kiotomatiki. Majibu hayasomwi.',
  },
};

const SUBJECT_MAX = 150;
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? '');
const forHeader = (name: string) => name.replace(/[‌‍]/g, '');
const isolateText = (name: string) => `⁨${name}⁩`;
const isolateHtml = (name: string) => `<bdi>${escapeHtml(name)}</bdi>`;

export interface AccessApprovedInput {
  /** The requester's own language (user_profiles.locale); unknown values fall back to English. */
  locale: string | null | undefined;
  approverName: string;
  boardName: string;
  /** The board's address in the app (built by the caller from the site address and the board id). */
  link: string;
}

export function renderAccessApprovedEmail(input: AccessApprovedInput): RenderedEmail {
  const locale: MailLocale = isMailLocale(input.locale) ? input.locale : 'en';
  const s = T[locale];
  const approver = clean(input.approverName) || 'Lanefold';
  const board = clean(input.boardName) || 'Lanefold';
  const link = clean(input.link, 300);
  const subject = clean(fill(s.subject, {board: forHeader(board)}), SUBJECT_MAX);
  const intro = fill(s.intro, {approver: isolateText(approver), board: isolateText(board)});
  const introHtml = fill(escapeHtml(s.intro), {approver: isolateHtml(approver), board: isolateHtml(board)});
  const text = [intro, '', s.open, link, '', '--', s.noreply].join('\n');
  const dir = locale === 'ar' || locale === 'ur' || locale === 'fa' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${locale}" dir="${dir}"><body>` +
    `<p>${introHtml}</p>` +
    `<p>${escapeHtml(s.open)}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
    `<p><small>${escapeHtml(s.noreply)}</small></p></body></html>`;
  return {subject, text, html};
}

/** The board's address in the app (src/app/routes.tsx: `/b/$boardId` under `/app`). */
export const boardLink = (origin: string, boardId: number) => `${origin.replace(/\/+$/, '')}/app/b/${boardId}`;
