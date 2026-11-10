import {LOCALES} from '../validation';

/**
 * Invite email templates: subject + plain text + a simple HTML version, in all 20 launch languages.
 *
 * Every dynamic value (inviter name, workspace name, role, date, link) goes through `clean()` (no control, line
 * break or bidi characters, length-capped) and the HTML version through `escapeHtml()`, so a hostile workspace name can
 * neither inject markup nor a header line into the subject.
 *
 * REVIEW STATUS: English is final. The 19 other languages are careful machine drafts and ALL need review by a native
 * speaker before launch (same status as src/i18n/messages; see docs/product/reviews/i18n-qa.md): needs-review.
 */

export type MailLocale = (typeof LOCALES)[number];

interface Strings {
  /** {inviter}, {workspace} */
  subject: string;
  /** {inviter}, {workspace}, {role} */
  intro: string;
  /** A board invite (Share by email): {inviter}, {board} */
  boardSubject: string;
  /** {inviter}, {board}, {role} */
  boardIntro: string;
  open: string;
  /** {date} */
  expires: string;
  ignore: string;
  noreply: string;
  roles: {viewer: string; member: string; admin: string};
}

const T: Record<MailLocale, Strings> = {
  en: {
    subject: '{inviter} invited you to {workspace} on Lanefold',
    intro: '{inviter} invited you to join the workspace "{workspace}" on Lanefold as {role}.',
    boardSubject: '{inviter} invited you to the board {board} on Lanefold',
    boardIntro: '{inviter} invited you to the board "{board}" on Lanefold as {role}.',
    open: 'Open this link to accept the invitation:',
    expires: 'The link works once and expires on {date}.',
    ignore: 'If you were not expecting this invitation, you can ignore this email.',
    noreply: 'This is an automated message. Replies are not read.',
    roles: {viewer: 'viewer', member: 'member', admin: 'admin'},
  },
  // needs-review: every locale below.
  bn: {
    subject: '{inviter} আপনাকে Lanefold-এ "{workspace}" ওয়ার্কস্পেসে আমন্ত্রণ জানিয়েছেন',
    intro: '{inviter} আপনাকে Lanefold-এ "{workspace}" ওয়ার্কস্পেসে {role} হিসেবে যোগ দিতে আমন্ত্রণ জানিয়েছেন।',
    boardSubject: '{inviter} আপনাকে Lanefold-এ "{board}" বোর্ডে আমন্ত্রণ জানিয়েছেন',
    boardIntro: '{inviter} আপনাকে Lanefold-এ "{board}" বোর্ডে {role} হিসেবে আমন্ত্রণ জানিয়েছেন।',
    open: 'আমন্ত্রণ গ্রহণ করতে এই লিংকটি খুলুন:',
    expires: 'লিংকটি একবারই কাজ করবে এবং {date} তারিখে মেয়াদ শেষ হবে।',
    ignore: 'আপনি এই আমন্ত্রণের আশা না করলে এই ইমেইলটি উপেক্ষা করতে পারেন।',
    noreply: 'এটি একটি স্বয়ংক্রিয় বার্তা। উত্তর পড়া হয় না।',
    roles: {viewer: 'দর্শক', member: 'সদস্য', admin: 'অ্যাডমিন'},
  },
  hi: {
    subject: '{inviter} ने आपको Lanefold पर "{workspace}" में आमंत्रित किया है',
    intro: '{inviter} ने आपको Lanefold पर "{workspace}" वर्कस्पेस में {role} के रूप में जुड़ने के लिए आमंत्रित किया है।',
    boardSubject: '{inviter} ने आपको Lanefold पर "{board}" बोर्ड में आमंत्रित किया',
    boardIntro: '{inviter} ने आपको Lanefold पर "{board}" बोर्ड में {role} के रूप में आमंत्रित किया है।',
    open: 'आमंत्रण स्वीकार करने के लिए यह लिंक खोलें:',
    expires: 'यह लिंक केवल एक बार काम करता है और {date} को समाप्त हो जाएगा।',
    ignore: 'यदि आप इस आमंत्रण की अपेक्षा नहीं कर रहे थे, तो इस ईमेल को अनदेखा कर दें।',
    noreply: 'यह एक स्वचालित संदेश है। उत्तर नहीं पढ़े जाते।',
    roles: {viewer: 'दर्शक', member: 'सदस्य', admin: 'एडमिन'},
  },
  ur: {
    subject: '{inviter} نے آپ کو Lanefold پر "{workspace}" میں مدعو کیا ہے',
    intro: '{inviter} نے آپ کو Lanefold پر "{workspace}" ورک اسپیس میں بطور {role} شامل ہونے کی دعوت دی ہے۔',
    boardSubject: '{inviter} نے آپ کو Lanefold پر "{board}" بورڈ میں مدعو کیا',
    boardIntro: '{inviter} نے آپ کو Lanefold پر "{board}" بورڈ میں {role} کے طور پر مدعو کیا ہے۔',
    open: 'دعوت قبول کرنے کے لیے یہ لنک کھولیں:',
    expires: 'یہ لنک صرف ایک بار کام کرتا ہے اور {date} کو ختم ہو جائے گا۔',
    ignore: 'اگر آپ کو اس دعوت کی توقع نہیں تھی تو اس ای میل کو نظر انداز کر دیں۔',
    noreply: 'یہ ایک خودکار پیغام ہے۔ جوابات نہیں پڑھے جاتے۔',
    roles: {viewer: 'ناظر', member: 'رکن', admin: 'ایڈمن'},
  },
  ar: {
    subject: 'دعاك {inviter} إلى "{workspace}" على Lanefold',
    intro: 'دعاك {inviter} للانضمام إلى مساحة العمل "{workspace}" على Lanefold بصفة {role}.',
    boardSubject: 'دعاك {inviter} إلى اللوحة "{board}" على Lanefold',
    boardIntro: 'دعاك {inviter} إلى اللوحة "{board}" على Lanefold بصفة {role}.',
    open: 'افتح هذا الرابط لقبول الدعوة:',
    expires: 'يعمل الرابط مرة واحدة وتنتهي صلاحيته في {date}.',
    ignore: 'إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل هذه الرسالة.',
    noreply: 'هذه رسالة آلية. لا تتم قراءة الردود.',
    roles: {viewer: 'مشاهد', member: 'عضو', admin: 'مسؤول'},
  },
  fa: {
    subject: '{inviter} شما را به «{workspace}» در Lanefold دعوت کرده است',
    intro: '{inviter} شما را به عنوان {role} به فضای کاری «{workspace}» در Lanefold دعوت کرده است.',
    boardSubject: '{inviter} شما را به برد "{board}" در Lanefold دعوت کرد',
    boardIntro: '{inviter} شما را به برد "{board}" در Lanefold با نقش {role} دعوت کرده است.',
    open: 'برای پذیرفتن دعوت، این پیوند را باز کنید:',
    expires: 'این پیوند فقط یک بار کار می‌کند و در تاریخ {date} منقضی می‌شود.',
    ignore: 'اگر منتظر این دعوت نبودید، می‌توانید این ایمیل را نادیده بگیرید.',
    noreply: 'این یک پیام خودکار است. پاسخ‌ها خوانده نمی‌شوند.',
    roles: {viewer: 'بیننده', member: 'عضو', admin: 'مدیر'},
  },
  es: {
    subject: '{inviter} te invitó a {workspace} en Lanefold',
    intro: '{inviter} te invitó a unirte al espacio de trabajo "{workspace}" en Lanefold como {role}.',
    boardSubject: '{inviter} te invitó al tablero {board} en Lanefold',
    boardIntro: '{inviter} te invitó al tablero "{board}" en Lanefold como {role}.',
    open: 'Abre este enlace para aceptar la invitación:',
    expires: 'El enlace funciona una sola vez y caduca el {date}.',
    ignore: 'Si no esperabas esta invitación, puedes ignorar este correo.',
    noreply: 'Este es un mensaje automático. Las respuestas no se leen.',
    roles: {viewer: 'lector', member: 'miembro', admin: 'administrador'},
  },
  fr: {
    subject: '{inviter} vous a invité à {workspace} sur Lanefold',
    intro: '{inviter} vous a invité à rejoindre l’espace de travail "{workspace}" sur Lanefold en tant que {role}.',
    boardSubject: '{inviter} vous a invité au tableau {board} sur Lanefold',
    boardIntro: '{inviter} vous a invité au tableau « {board} » sur Lanefold en tant que {role}.',
    open: 'Ouvrez ce lien pour accepter l’invitation :',
    expires: 'Le lien ne fonctionne qu’une fois et expire le {date}.',
    ignore: 'Si vous n’attendiez pas cette invitation, vous pouvez ignorer cet e-mail.',
    noreply: 'Ceci est un message automatique. Les réponses ne sont pas lues.',
    roles: {viewer: 'lecteur', member: 'membre', admin: 'administrateur'},
  },
  pt: {
    subject: '{inviter} convidou você para {workspace} no Lanefold',
    intro: '{inviter} convidou você para participar do espaço de trabalho "{workspace}" no Lanefold como {role}.',
    boardSubject: '{inviter} convidou você para o quadro {board} no Lanefold',
    boardIntro: '{inviter} convidou você para o quadro "{board}" no Lanefold como {role}.',
    open: 'Abra este link para aceitar o convite:',
    expires: 'O link funciona uma única vez e expira em {date}.',
    ignore: 'Se você não esperava este convite, pode ignorar este e-mail.',
    noreply: 'Esta é uma mensagem automática. As respostas não são lidas.',
    roles: {viewer: 'leitor', member: 'membro', admin: 'administrador'},
  },
  de: {
    subject: '{inviter} hat dich zu {workspace} auf Lanefold eingeladen',
    intro: '{inviter} hat dich eingeladen, dem Arbeitsbereich "{workspace}" auf Lanefold als {role} beizutreten.',
    boardSubject: '{inviter} hat dich zum Board {board} auf Lanefold eingeladen',
    boardIntro: '{inviter} hat dich als {role} zum Board „{board}“ auf Lanefold eingeladen.',
    open: 'Öffne diesen Link, um die Einladung anzunehmen:',
    expires: 'Der Link funktioniert nur einmal und läuft am {date} ab.',
    ignore: 'Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.',
    noreply: 'Dies ist eine automatische Nachricht. Antworten werden nicht gelesen.',
    roles: {viewer: 'Betrachter', member: 'Mitglied', admin: 'Admin'},
  },
  it: {
    subject: '{inviter} ti ha invitato a {workspace} su Lanefold',
    intro: '{inviter} ti ha invitato a unirti allo spazio di lavoro "{workspace}" su Lanefold come {role}.',
    boardSubject: '{inviter} ti ha invitato alla bacheca {board} su Lanefold',
    boardIntro: '{inviter} ti ha invitato alla bacheca "{board}" su Lanefold come {role}.',
    open: 'Apri questo link per accettare l’invito:',
    expires: 'Il link funziona una sola volta e scade il {date}.',
    ignore: 'Se non ti aspettavi questo invito, puoi ignorare questa email.',
    noreply: 'Questo è un messaggio automatico. Le risposte non vengono lette.',
    roles: {viewer: 'lettore', member: 'membro', admin: 'amministratore'},
  },
  ru: {
    subject: '{inviter} приглашает вас в «{workspace}» на Lanefold',
    intro: '{inviter} приглашает вас присоединиться к рабочему пространству «{workspace}» на Lanefold в роли: {role}.',
    boardSubject: '{inviter} пригласил(а) вас на доску {board} в Lanefold',
    boardIntro: '{inviter} пригласил(а) вас на доску «{board}» в Lanefold с ролью {role}.',
    open: 'Откройте эту ссылку, чтобы принять приглашение:',
    expires: 'Ссылка работает один раз и действует до {date}.',
    ignore: 'Если вы не ждали это приглашение, просто проигнорируйте письмо.',
    noreply: 'Это автоматическое сообщение. Ответы не читаются.',
    roles: {viewer: 'наблюдатель', member: 'участник', admin: 'администратор'},
  },
  tr: {
    subject: '{inviter} sizi Lanefold’da {workspace} çalışma alanına davet etti',
    intro: '{inviter} sizi Lanefold’da "{workspace}" çalışma alanına {role} olarak katılmaya davet etti.',
    boardSubject: '{inviter} sizi Lanefold\'da {board} panosuna davet etti',
    boardIntro: '{inviter} sizi Lanefold\'da "{board}" panosuna {role} olarak davet etti.',
    open: 'Daveti kabul etmek için bu bağlantıyı açın:',
    expires: 'Bağlantı yalnızca bir kez çalışır ve {date} tarihinde sona erer.',
    ignore: 'Bu daveti beklemiyorsanız bu e-postayı yok sayabilirsiniz.',
    noreply: 'Bu otomatik bir iletidir. Yanıtlar okunmaz.',
    roles: {viewer: 'izleyici', member: 'üye', admin: 'yönetici'},
  },
  id: {
    subject: '{inviter} mengundang Anda ke {workspace} di Lanefold',
    intro: '{inviter} mengundang Anda bergabung ke ruang kerja "{workspace}" di Lanefold sebagai {role}.',
    boardSubject: '{inviter} mengundang Anda ke papan {board} di Lanefold',
    boardIntro: '{inviter} mengundang Anda ke papan "{board}" di Lanefold sebagai {role}.',
    open: 'Buka tautan ini untuk menerima undangan:',
    expires: 'Tautan hanya berfungsi sekali dan kedaluwarsa pada {date}.',
    ignore: 'Jika Anda tidak mengharapkan undangan ini, abaikan email ini.',
    noreply: 'Ini adalah pesan otomatis. Balasan tidak dibaca.',
    roles: {viewer: 'pembaca', member: 'anggota', admin: 'admin'},
  },
  zh: {
    subject: '{inviter} 邀请你加入 Lanefold 上的 {workspace}',
    intro: '{inviter} 邀请你以{role}身份加入 Lanefold 上的工作区“{workspace}”。',
    boardSubject: '{inviter} 邀请你加入 Lanefold 上的看板 {board}',
    boardIntro: '{inviter} 邀请你以{role}身份加入 Lanefold 上的看板“{board}”。',
    open: '打开此链接接受邀请：',
    expires: '该链接仅可使用一次，将于 {date} 过期。',
    ignore: '如果你没有预期收到此邀请，请忽略这封邮件。',
    noreply: '这是一封自动发送的邮件，回复不会被阅读。',
    roles: {viewer: '查看者', member: '成员', admin: '管理员'},
  },
  ja: {
    subject: '{inviter} さんが Lanefold の {workspace} に招待しました',
    intro: '{inviter} さんが、Lanefold のワークスペース「{workspace}」に{role}として参加するようあなたを招待しました。',
    boardSubject: '{inviter} さんが Lanefold のボード {board} に招待しました',
    boardIntro: '{inviter} さんが Lanefold のボード「{board}」に{role}として招待しました。',
    open: '招待を承諾するには、次のリンクを開いてください。',
    expires: 'このリンクは一度だけ使え、{date} に期限が切れます。',
    ignore: 'この招待に心当たりがない場合は、このメールを無視してください。',
    noreply: 'これは自動送信のメールです。返信は確認されません。',
    roles: {viewer: '閲覧者', member: 'メンバー', admin: '管理者'},
  },
  ko: {
    subject: '{inviter}님이 Lanefold의 {workspace}에 초대했습니다',
    intro: '{inviter}님이 Lanefold의 "{workspace}" 워크스페이스에 {role}(으)로 참여하도록 초대했습니다.',
    boardSubject: '{inviter}님이 Lanefold의 {board} 보드에 초대했습니다',
    boardIntro: '{inviter}님이 Lanefold의 "{board}" 보드에 {role}(으)로 초대했습니다.',
    open: '초대를 수락하려면 이 링크를 여세요:',
    expires: '이 링크는 한 번만 사용할 수 있으며 {date}에 만료됩니다.',
    ignore: '이 초대를 예상하지 않으셨다면 이 이메일을 무시하셔도 됩니다.',
    noreply: '자동 발송된 메시지입니다. 답장은 확인되지 않습니다.',
    roles: {viewer: '보기 전용', member: '멤버', admin: '관리자'},
  },
  vi: {
    subject: '{inviter} đã mời bạn vào {workspace} trên Lanefold',
    intro: '{inviter} đã mời bạn tham gia không gian làm việc "{workspace}" trên Lanefold với vai trò {role}.',
    boardSubject: '{inviter} đã mời bạn vào bảng {board} trên Lanefold',
    boardIntro: '{inviter} đã mời bạn vào bảng "{board}" trên Lanefold với vai trò {role}.',
    open: 'Mở liên kết này để chấp nhận lời mời:',
    expires: 'Liên kết chỉ dùng được một lần và hết hạn vào {date}.',
    ignore: 'Nếu bạn không mong đợi lời mời này, hãy bỏ qua email này.',
    noreply: 'Đây là thư tự động. Thư trả lời sẽ không được đọc.',
    roles: {viewer: 'người xem', member: 'thành viên', admin: 'quản trị viên'},
  },
  th: {
    subject: '{inviter} เชิญคุณเข้าร่วม {workspace} บน Lanefold',
    intro: '{inviter} เชิญคุณเข้าร่วมพื้นที่ทำงาน "{workspace}" บน Lanefold ในฐานะ{role}',
    boardSubject: '{inviter} เชิญคุณเข้าบอร์ด {board} บน Lanefold',
    boardIntro: '{inviter} เชิญคุณเข้าบอร์ด "{board}" บน Lanefold ในบทบาท {role}',
    open: 'เปิดลิงก์นี้เพื่อตอบรับคำเชิญ:',
    expires: 'ลิงก์ใช้ได้เพียงครั้งเดียวและจะหมดอายุในวันที่ {date}',
    ignore: 'หากคุณไม่ได้คาดหวังคำเชิญนี้ คุณสามารถเพิกเฉยต่ออีเมลนี้ได้',
    noreply: 'นี่คือข้อความอัตโนมัติ ระบบไม่อ่านอีเมลตอบกลับ',
    roles: {viewer: 'ผู้ชม', member: 'สมาชิก', admin: 'ผู้ดูแล'},
  },
  sw: {
    subject: '{inviter} amekualika kwenye {workspace} katika Lanefold',
    intro: '{inviter} amekualika ujiunge na nafasi ya kazi "{workspace}" katika Lanefold kama {role}.',
    boardSubject: '{inviter} amekualika kwenye ubao {board} kwenye Lanefold',
    boardIntro: '{inviter} amekualika kwenye ubao "{board}" kwenye Lanefold kama {role}.',
    open: 'Fungua kiungo hiki ili kukubali mwaliko:',
    expires: 'Kiungo hufanya kazi mara moja tu na kitaisha muda tarehe {date}.',
    ignore: 'Kama hukutarajia mwaliko huu, unaweza kupuuza barua pepe hii.',
    noreply: 'Huu ni ujumbe wa kiotomatiki. Majibu hayasomwi.',
    roles: {viewer: 'mtazamaji', member: 'mwanachama', admin: 'msimamizi'},
  },
};

const NAME_MAX = 60;
const SUBJECT_MAX = 150;

/**
 * Control characters (CR, LF, tabs, NUL…), bidi overrides and zero-width marks: removed; whitespace collapsed; capped.
 * ZWNJ (U+200C) and ZWJ (U+200D) are kept only singly between two non-space characters (Persian names, emoji
 * sequences); at the ends, next to a space or repeated they are removed like the rest.
 */
export function clean(value: unknown, max = NAME_MAX): string {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u2060-\u2064\u2028\u2029\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ');
  const joined = stripped
    .replace(/[\u200C\u200D]+/g, (run, offset: number, all: string) =>
      run.length === 1 && offset > 0 && offset + 1 < all.length && !/\s/.test(all[offset - 1]) && !/\s/.test(all[offset + 1]) ? run : ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...joined].slice(0, max).join('').replace(/[\u200C\u200D]+$/, '');
}

const JOINERS = /[\u200C\u200D]/g;
/** For headers (the subject): no joiners at all, so no invisible character reaches them. */
const forHeader = (name: string) => name.replace(JOINERS, '');
/** Plain-text isolation of a (cleaned) name: FSI … PDI. Added after clean(), never in a header. */
const isolateText = (name: string) => `\u2068${name}\u2069`;
const isolateHtml = (name: string) => `<bdi>${escapeHtml(name)}</bdi>`;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const isMailLocale = (value: unknown): value is MailLocale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? '');

export interface InviteEmailInput {
  /** The workspace's default locale; unknown values fall back to English. */
  locale: string | null | undefined;
  inviterName: string;
  workspaceName: string;
  role: string;
  /** Set for a board invite: the email names the board instead of the workspace. */
  boardName?: string | null;
  expiresAt: Date;
  /** The full invite link (built by the caller from the site address and the token). */
  link: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function formatDate(date: Date, locale: MailLocale): string {
  try {
    return new Intl.DateTimeFormat(locale, {dateStyle: 'long', timeZone: 'UTC'}).format(date) + ' UTC';
  } catch {
    return date.toISOString().slice(0, 10) + ' UTC';
  }
}

export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const locale: MailLocale = isMailLocale(input.locale) ? input.locale : 'en';
  const s = T[locale];
  const inviter = clean(input.inviterName) || 'Lanefold';
  const workspace = clean(input.workspaceName) || 'Lanefold';
  const role = s.roles[input.role as keyof Strings['roles']] ?? s.roles.member;
  const date = formatDate(input.expiresAt, locale);
  const link = clean(input.link, 300);

  const board = input.boardName ? clean(input.boardName) || 'Lanefold' : null;
  const subject = board
    ? clean(fill(s.boardSubject, {inviter: forHeader(inviter), board: forHeader(board)}), SUBJECT_MAX)
    : clean(fill(s.subject, {inviter: forHeader(inviter), workspace: forHeader(workspace)}), SUBJECT_MAX);
  const intro = board
    ? fill(s.boardIntro, {inviter: isolateText(inviter), board: isolateText(board), role})
    : fill(s.intro, {inviter: isolateText(inviter), workspace: isolateText(workspace), role});
  const introHtml = board
    ? fill(escapeHtml(s.boardIntro), {inviter: isolateHtml(inviter), board: isolateHtml(board), role: escapeHtml(role)})
    : fill(escapeHtml(s.intro), {inviter: isolateHtml(inviter), workspace: isolateHtml(workspace), role: escapeHtml(role)});
  const expires = fill(s.expires, {date});
  const text = [intro, '', s.open, link, '', expires, s.ignore, '', '--', s.noreply].join('\n');
  const dir = locale === 'ar' || locale === 'ur' || locale === 'fa' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${locale}" dir="${dir}"><body>` +
    `<p>${introHtml}</p>` +
    `<p>${escapeHtml(s.open)}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
    `<p>${escapeHtml(expires)}<br>${escapeHtml(s.ignore)}</p>` +
    `<p><small>${escapeHtml(s.noreply)}</small></p></body></html>`;
  return {subject, text, html};
}

/** The invite link path (src/app/routes.tsx: `/join/$token` under `/app`). */
export const inviteLink = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/app/join/${token}`;
