import type {Translations} from '@videojs/react/i18n';

export type {Translations as VideoJsTranslations} from '@videojs/react/i18n';

// VideoPlayerLabels is the copy the components show. `player` holds Video.js's
// own keys (its translation-phrases reference); without it Video.js loads its
// pack for the locale.
export type VideoPlayerLabels = {
  player?: Partial<Translations>;
  speed: string;
  quality: string;
  settings: string; // the gear: speed and quality
  captions: string; // the captions menu (a video with more than one track)
  interactions: string;
  question: string;
  answers: string;
  checkAnswer: string;
  continue: string;
  skip: string;
  correct: string;
  tryAgain: string;
  wrongAnswer: (answer: string) => string;
  hint: (hint: string) => string;
  chooseAnswer: string;
  answerToContinue: string;
  finishStep: string;
  emailGate: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  invalidEmail: string;
  backgroundPlay: string;
  backgroundPause: string;
  askAi: string; // the control bar's Ask AI button (onAskAi)
  watchAgain: string; // the end screen's replay
  // The key moments (chapters): the button after the time and its panel.
  chapterButton: (title: string, n: number, total: number) => string;
  keyMoments: string;
  keyMomentsCount: (n: number) => string;
  closeKeyMoments: string;
  chapterItem: (title: string, time: string, locked: boolean) => string;
};

// AudioPlayerLabels is the audio player's copy: Video.js's own keys only
// (its controls are Video.js's). Without them Video.js loads its pack for
// the locale.
export type AudioPlayerLabels = {
  player?: Partial<Translations>;
};

export const englishLabels: VideoPlayerLabels = {
  watchAgain: 'Watch again',
  speed: 'Playback speed',
  quality: 'Quality',
  settings: 'Settings',
  captions: 'Captions',
  interactions: 'Interactions',
  question: 'Question',
  answers: 'Answers',
  checkAnswer: 'Check answer',
  continue: 'Continue',
  skip: 'Skip',
  correct: 'Correct.',
  tryAgain: 'Not quite. Try again.',
  wrongAnswer: (answer) => `Not quite. The correct answer is ${answer}.`,
  hint: (hint) => `Hint: ${hint}`,
  chooseAnswer: 'Choose an answer first',
  answerToContinue: 'Answer the question to continue',
  finishStep: 'Finish this step to continue',
  emailGate: 'Email gate',
  email: 'Email',
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  invalidEmail: 'Not a valid email address',
  backgroundPlay: 'Play background video',
  backgroundPause: 'Pause background video',
  askAi: 'Ask AI',
  chapterButton: (title, n, total) => `Key moments: ${title}, ${n} of ${total}`,
  keyMoments: 'Key moments',
  keyMomentsCount: (n) => (n === 1 ? '1 in this video' : `${n} in this video`),
  closeKeyMoments: 'Close key moments',
  chapterItem: (title, time, locked) =>
    locked ? `${title}, ${time}, not watched yet` : `${title}, ${time}`,
};
