import {clean, escapeHtml, isMailLocale, type MailLocale} from './templates';

/**
 * Notification email strings in the 20 launch languages (same pattern as the invite templates in ./templates.ts).
 * Counts only: no names, titles or addresses ever go in. The only dynamic values are two integers and the app link.
 *
 * REVIEW STATUS: English is final; the other 19 are careful machine drafts that need native review (needs-review).
 */

/** Plural forms by Intl.PluralRules category; `other` is always present. `{count}` is replaced. */
export interface Forms {
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export interface NotificationStrings {
  mentions: Forms;
  assigned: Forms;
  /** {a}, {b}: joins the two counts. */
  and: string;
  /** {summary} */
  subject: string;
  /** {summary} */
  intro: string;
  open: string;
  reason: string;
  stop: string;
  off: string;
  noreply: string;
}

const same = (s: string): Forms => ({other: s});

export const NOTIFICATION_STRINGS: Record<MailLocale, NotificationStrings> = {
  en: {
    mentions: {one: '{count} mention', other: '{count} mentions'},
    assigned: {one: '{count} new assignment', other: '{count} new assignments'},
    and: '{a} and {b}',
    subject: 'You have {summary} on Lanefold',
    intro: 'You have {summary} waiting in Lanefold.',
    open: 'Open Lanefold:',
    reason: 'You get this because you turned on notification emails.',
    stop: 'To stop them, switch them off here:',
    off: 'Switch them off',
    noreply: 'This is an automated message. Replies are not read.',
  },
  // needs-review: every locale below.
  bn: {
    mentions: same('{count}টি উল্লেখ'),
    assigned: same('{count}টি নতুন অ্যাসাইনমেন্ট'),
    and: '{a} এবং {b}',
    subject: 'Lanefold-এ আপনার {summary} আছে',
    intro: 'Lanefold-এ আপনার {summary} অপেক্ষা করছে।',
    open: 'Lanefold খুলুন:',
    reason: 'আপনি নোটিফিকেশন ইমেইল চালু করেছেন বলে এটি পাচ্ছেন।',
    stop: 'এগুলো বন্ধ করতে এখানে বন্ধ করুন:',
    off: 'বন্ধ করুন',
    noreply: 'এটি একটি স্বয়ংক্রিয় বার্তা। উত্তর পড়া হয় না।',
  },
  hi: {
    mentions: same('{count} उल्लेख'),
    assigned: same('{count} नया असाइनमेंट'),
    and: '{a} और {b}',
    subject: 'Lanefold पर आपके {summary} हैं',
    intro: 'Lanefold में आपके {summary} प्रतीक्षा कर रहे हैं।',
    open: 'Lanefold खोलें:',
    reason: 'आपको यह इसलिए मिल रहा है क्योंकि आपने नोटिफ़िकेशन ईमेल चालू किए हैं।',
    stop: 'इन्हें रोकने के लिए यहाँ बंद करें:',
    off: 'बंद करें',
    noreply: 'यह एक स्वचालित संदेश है। उत्तर नहीं पढ़े जाते।',
  },
  ur: {
    mentions: same('{count} ذکر'),
    assigned: same('{count} نئی تفویض'),
    and: '{a} اور {b}',
    subject: 'Lanefold پر آپ کے لیے {summary} ہیں',
    intro: 'Lanefold میں آپ کے لیے {summary} منتظر ہیں۔',
    open: 'Lanefold کھولیں:',
    reason: 'آپ کو یہ اس لیے مل رہی ہے کہ آپ نے اطلاعاتی ای میلز آن کی ہیں۔',
    stop: 'انہیں بند کرنے کے لیے یہاں بند کریں:',
    off: 'بند کریں',
    noreply: 'یہ ایک خودکار پیغام ہے۔ جوابات نہیں پڑھے جاتے۔',
  },
  ar: {
    mentions: {one: 'إشارة واحدة', two: 'إشارتان', few: '{count} إشارات', many: '{count} إشارة', other: '{count} إشارة'},
    assigned: {one: 'مهمة جديدة واحدة', two: 'مهمتان جديدتان', few: '{count} مهام جديدة', many: '{count} مهمة جديدة', other: '{count} مهمة جديدة'},
    and: '{a} و{b}',
    subject: 'لديك {summary} على Lanefold',
    intro: 'لديك {summary} بانتظارك في Lanefold.',
    open: 'افتح Lanefold:',
    reason: 'تصلك هذه الرسالة لأنك فعّلت رسائل الإشعارات.',
    stop: 'لإيقافها، أوقفها من هنا:',
    off: 'إيقاف الرسائل',
    noreply: 'هذه رسالة آلية. لا تتم قراءة الردود.',
  },
  fa: {
    mentions: same('{count} اشاره'),
    assigned: same('{count} واگذاری جدید'),
    and: '{a} و {b}',
    subject: 'در Lanefold {summary} دارید',
    intro: 'در Lanefold {summary} منتظر شماست.',
    open: 'باز کردن Lanefold:',
    reason: 'این ایمیل را دریافت می‌کنید چون ایمیل اعلان‌ها را روشن کرده‌اید.',
    stop: 'برای توقف آن‌ها، از اینجا خاموششان کنید:',
    off: 'خاموش کردن',
    noreply: 'این یک پیام خودکار است. پاسخ‌ها خوانده نمی‌شوند.',
  },
  es: {
    mentions: {one: '{count} mención', other: '{count} menciones'},
    assigned: {one: '{count} asignación nueva', other: '{count} asignaciones nuevas'},
    and: '{a} y {b}',
    subject: 'Tienes {summary} en Lanefold',
    intro: 'Tienes {summary} esperándote en Lanefold.',
    open: 'Abrir Lanefold:',
    reason: 'Recibes este correo porque activaste los correos de notificaciones.',
    stop: 'Para dejar de recibirlos, desactívalos aquí:',
    off: 'Desactivarlos',
    noreply: 'Este es un mensaje automático. Las respuestas no se leen.',
  },
  fr: {
    mentions: {one: '{count} mention', other: '{count} mentions'},
    assigned: {one: '{count} nouvelle attribution', other: '{count} nouvelles attributions'},
    and: '{a} et {b}',
    subject: 'Vous avez {summary} sur Lanefold',
    intro: 'Vous avez {summary} dans Lanefold.',
    open: 'Ouvrir Lanefold :',
    reason: 'Vous recevez ce message parce que vous avez activé les e-mails de notification.',
    stop: 'Pour ne plus en recevoir, désactivez-les ici :',
    off: 'Les désactiver',
    noreply: 'Ceci est un message automatique. Les réponses ne sont pas lues.',
  },
  pt: {
    mentions: {one: '{count} menção', other: '{count} menções'},
    assigned: {one: '{count} nova atribuição', other: '{count} novas atribuições'},
    and: '{a} e {b}',
    subject: 'Você tem {summary} no Lanefold',
    intro: 'Você tem {summary} esperando no Lanefold.',
    open: 'Abrir o Lanefold:',
    reason: 'Você recebe este e-mail porque ativou os e-mails de notificação.',
    stop: 'Para parar de recebê-los, desative-os aqui:',
    off: 'Desativá-los',
    noreply: 'Esta é uma mensagem automática. As respostas não são lidas.',
  },
  de: {
    mentions: {one: '{count} Erwähnung', other: '{count} Erwähnungen'},
    assigned: {one: '{count} neue Zuweisung', other: '{count} neue Zuweisungen'},
    and: '{a} und {b}',
    subject: 'Du hast {summary} in Lanefold',
    intro: 'Du hast {summary} in Lanefold.',
    open: 'Lanefold öffnen:',
    reason: 'Du erhältst diese E-Mail, weil du Benachrichtigungs-E-Mails aktiviert hast.',
    stop: 'Um sie zu beenden, schalte sie hier aus:',
    off: 'Ausschalten',
    noreply: 'Dies ist eine automatische Nachricht. Antworten werden nicht gelesen.',
  },
  it: {
    mentions: {one: '{count} menzione', other: '{count} menzioni'},
    assigned: {one: '{count} nuova assegnazione', other: '{count} nuove assegnazioni'},
    and: '{a} e {b}',
    subject: 'Hai {summary} su Lanefold',
    intro: 'Hai {summary} su Lanefold.',
    open: 'Apri Lanefold:',
    reason: 'Ricevi questa email perché hai attivato le email di notifica.',
    stop: 'Per non riceverle più, disattivale qui:',
    off: 'Disattiva',
    noreply: 'Questo è un messaggio automatico. Le risposte non vengono lette.',
  },
  ru: {
    mentions: {one: '{count} упоминание', few: '{count} упоминания', many: '{count} упоминаний', other: '{count} упоминания'},
    assigned: {one: '{count} новое назначение', few: '{count} новых назначения', many: '{count} новых назначений', other: '{count} новых назначения'},
    and: '{a} и {b}',
    subject: 'В Lanefold вас ждут: {summary}',
    intro: 'В Lanefold вас ждут: {summary}.',
    open: 'Открыть Lanefold:',
    reason: 'Вы получаете это письмо, потому что включили уведомления по почте.',
    stop: 'Чтобы отключить их, зайдите сюда:',
    off: 'Отключить',
    noreply: 'Это автоматическое сообщение. Ответы не читаются.',
  },
  tr: {
    mentions: same('{count} bahsetme'),
    assigned: same('{count} yeni atama'),
    and: '{a} ve {b}',
    subject: 'Lanefold’da {summary} sizi bekliyor',
    intro: 'Lanefold’da {summary} sizi bekliyor.',
    open: 'Lanefold’u açın:',
    reason: 'Bildirim e-postalarını açtığınız için bunu alıyorsunuz.',
    stop: 'Bunları durdurmak için buradan kapatın:',
    off: 'Kapat',
    noreply: 'Bu otomatik bir iletidir. Yanıtlar okunmaz.',
  },
  id: {
    mentions: same('{count} sebutan'),
    assigned: same('{count} penugasan baru'),
    and: '{a} dan {b}',
    subject: 'Anda punya {summary} di Lanefold',
    intro: 'Anda punya {summary} yang menunggu di Lanefold.',
    open: 'Buka Lanefold:',
    reason: 'Anda menerima ini karena mengaktifkan email notifikasi.',
    stop: 'Untuk berhenti menerimanya, matikan di sini:',
    off: 'Matikan',
    noreply: 'Ini adalah pesan otomatis. Balasan tidak dibaca.',
  },
  zh: {
    mentions: same('{count} 条提及'),
    assigned: same('{count} 项新分配'),
    and: '{a}和{b}',
    subject: '你在 Lanefold 上有{summary}',
    intro: 'Lanefold 中有{summary}在等你。',
    open: '打开 Lanefold：',
    reason: '你收到此邮件，是因为你开启了通知邮件。',
    stop: '如需停止，请在此关闭：',
    off: '关闭通知邮件',
    noreply: '这是一封自动邮件，回复不会被阅读。',
  },
  ja: {
    mentions: same('メンション{count}件'),
    assigned: same('新しい割り当て{count}件'),
    and: '{a}と{b}',
    subject: 'Lanefold に{summary}があります',
    intro: 'Lanefold で{summary}があなたを待っています。',
    open: 'Lanefold を開く：',
    reason: '通知メールをオンにしているため、このメールが届いています。',
    stop: '停止するには、こちらでオフにしてください：',
    off: 'オフにする',
    noreply: 'これは自動送信のメッセージです。返信は確認されません。',
  },
  ko: {
    mentions: same('멘션 {count}건'),
    assigned: same('새 할당 {count}건'),
    and: '{a} 및 {b}',
    subject: 'Lanefold에 {summary}이(가) 있습니다',
    intro: 'Lanefold에서 {summary}이(가) 기다리고 있습니다.',
    open: 'Lanefold 열기:',
    reason: '알림 이메일을 켜셨기 때문에 이 메일을 받으셨습니다.',
    stop: '받지 않으려면 여기에서 끄세요:',
    off: '끄기',
    noreply: '자동으로 발송된 메시지입니다. 회신은 확인되지 않습니다.',
  },
  vi: {
    mentions: same('{count} lượt nhắc'),
    assigned: same('{count} nhiệm vụ mới được giao'),
    and: '{a} và {b}',
    subject: 'Bạn có {summary} trên Lanefold',
    intro: 'Bạn có {summary} đang chờ trong Lanefold.',
    open: 'Mở Lanefold:',
    reason: 'Bạn nhận email này vì bạn đã bật email thông báo.',
    stop: 'Để dừng nhận, hãy tắt tại đây:',
    off: 'Tắt',
    noreply: 'Đây là tin nhắn tự động. Phản hồi sẽ không được đọc.',
  },
  th: {
    mentions: same('การกล่าวถึง {count} รายการ'),
    assigned: same('งานที่มอบหมายใหม่ {count} รายการ'),
    and: '{a} และ{b}',
    subject: 'คุณมี{summary}ใน Lanefold',
    intro: 'มี{summary}รอคุณอยู่ใน Lanefold',
    open: 'เปิด Lanefold:',
    reason: 'คุณได้รับอีเมลนี้เพราะเปิดอีเมลแจ้งเตือนไว้',
    stop: 'หากต้องการหยุดรับ ให้ปิดที่นี่:',
    off: 'ปิดการแจ้งเตือน',
    noreply: 'นี่คือข้อความอัตโนมัติ ระบบไม่อ่านคำตอบกลับ',
  },
  sw: {
    mentions: same('kutajwa mara {count}'),
    assigned: same('kukabidhiwa kazi mpya {count}'),
    and: '{a} na {b}',
    subject: 'Mpya kwenye Lanefold: {summary}',
    intro: 'Kwenye Lanefold kuna: {summary}.',
    open: 'Fungua Lanefold:',
    reason: 'Unapokea barua pepe hii kwa sababu uliwasha barua pepe za arifa.',
    stop: 'Ili kuziacha, zizime hapa:',
    off: 'Zizime',
    noreply: 'Huu ni ujumbe wa kiotomatiki. Majibu hayasomwi.',
  },
};

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? '');

function pick(forms: Forms, count: number, locale: MailLocale): string {
  let cat: keyof Forms = 'other';
  try {
    cat = new Intl.PluralRules(locale).select(count) as keyof Forms;
  } catch {
    /* English-style fallback below */
  }
  return fill(forms[cat] ?? forms.other, {count: String(count)});
}

/** Pure: the notification email for one person in their language (unknown locale: English). Counts only. */
export function renderLocalizedNotificationEmail(
  counts: {mentions: number; assigned: number},
  link: string,
  localeInput?: string | null,
): {subject: string; text: string; html: string} {
  const locale: MailLocale = isMailLocale(localeInput) ? localeInput : 'en';
  const s = NOTIFICATION_STRINGS[locale];
  const mentions = Math.max(0, Math.floor(Number(counts.mentions) || 0));
  const assigned = Math.max(0, Math.floor(Number(counts.assigned) || 0));
  const parts: string[] = [];
  if (mentions > 0) parts.push(pick(s.mentions, mentions, locale));
  if (assigned > 0) parts.push(pick(s.assigned, assigned, locale));
  const summary = parts.length === 2 ? fill(s.and, {a: parts[0], b: parts[1]}) : parts[0] ?? '';
  const safeLink = clean(link, 300);
  const settings = `${safeLink.replace(/\/+$/, '')}/settings/notifications`;
  const subject = clean(fill(s.subject, {summary}), 150);
  const intro = fill(s.intro, {summary});
  const text = [intro, '', `${s.open} ${safeLink}`, '', `${s.reason} ${s.stop} ${settings}`, s.noreply].join('\n');
  const dir = locale === 'ar' || locale === 'ur' || locale === 'fa' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${locale}" dir="${dir}"><body>` +
    `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(safeLink)}">${escapeHtml(s.open.replace(/\s*[:：]$/, ''))}</a></p>` +
    `<p style="color:#666;font-size:12px">${escapeHtml(s.reason)} <a href="${escapeHtml(settings)}">${escapeHtml(s.off)}</a>.</p>` +
    `<p style="color:#666;font-size:12px">${escapeHtml(s.noreply)}</p></body></html>`;
  return {subject, text, html};
}
