import {useId, type ReactNode} from 'react';

// The player's own icons (filled, 24×24, currentColor), so the controls
// look the same in every skin and nothing reads as another site's player.

type IconProps = {className?: string};

function Icon({className, children, ...rest}: IconProps & {children: ReactNode}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.8-6.86a1 1 0 0 0 0-1.7L9.52 4.3A1 1 0 0 0 8 5.14Z" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.3" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.3" />
  </Icon>
);

export const ReplayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5V2.2a.5.5 0 0 0-.85-.36L7.3 5.65a.5.5 0 0 0 0 .7l3.85 3.81A.5.5 0 0 0 12 9.8V7a6 6 0 1 1-6 6 1 1 0 0 0-2 0 8 8 0 1 0 8-8Z" />
  </Icon>
);

// SkipIcon is a circular arrow with the seconds in it: back turns left.
export function SkipIcon({className, seconds, back}: IconProps & {seconds: number; back: boolean}) {
  return (
    <Icon className={className}>
      <path
        d={
          back
            ? 'M12.5 3a9 9 0 1 1-8.94 10.02 1 1 0 0 1 1.99-.22A7 7 0 1 0 12.5 5H10v2.3a.5.5 0 0 1-.83.37L5.6 4.4a.5.5 0 0 1 0-.75L9.17.38A.5.5 0 0 1 10 .75V3h2.5Z'
            : 'M11.5 3a9 9 0 1 0 8.94 10.02 1 1 0 0 0-1.99-.22A7 7 0 1 1 11.5 5H14v2.3a.5.5 0 0 0 .83.37l3.57-3.27a.5.5 0 0 0 0-.75L14.83.38A.5.5 0 0 0 14 .75V3h-2.5Z'
        }
      />
      <text
        x={back ? 12.6 : 11.4}
        y="16.4"
        fontSize={seconds > 9 ? 7 : 8}
        fontWeight="700"
        textAnchor="middle"
        fontFamily="inherit"
      >
        {seconds}
      </text>
    </Icon>
  );
}

const speaker =
  'M3 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6A1 1 0 0 0 13 18.3V5.7a1 1 0 0 0-1.7-.8L7 8.5H4a1 1 0 0 0-1 1Z';

export const VolumeHighIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d={speaker} />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.8 5.7a9 9 0 0 1 0 12.6" {...stroke} />
  </Icon>
);

export const VolumeLowIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d={speaker} />
    <path d="M16 8.5a5 5 0 0 1 0 7" {...stroke} />
  </Icon>
);

export const MuteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d={speaker} />
    <path d="m16.5 9.5 5 5m0-5-5 5" {...stroke} />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6a.5.5 0 0 0 .12-.64l-1.9-3.3a.5.5 0 0 0-.6-.22l-2.4.96a7.3 7.3 0 0 0-1.7-1L14.5 2.6a.5.5 0 0 0-.5-.42h-3.8a.5.5 0 0 0-.5.42l-.36 2.56a7.3 7.3 0 0 0-1.7 1l-2.4-.96a.5.5 0 0 0-.6.22l-1.9 3.3a.5.5 0 0 0 .12.64l2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.12.64l1.9 3.3c.12.22.38.3.6.22l2.4-.96c.52.4 1.09.74 1.7 1l.36 2.56c.04.24.25.42.5.42h3.8c.25 0 .46-.18.5-.42l.36-2.56a7.3 7.3 0 0 0 1.7-1l2.4.96c.22.08.48 0 .6-.22l1.9-3.3a.5.5 0 0 0-.12-.64L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
  </Icon>
);

export const PipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v-2H4V6h16v5h2V6a2 2 0 0 0-2-2Z" />
    <rect x="13" y="13" width="9" height="7" rx="1.5" />
  </Icon>
);

export const FullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"
      {...stroke}
      strokeWidth={2.2}
    />
  </Icon>
);

export const FullscreenExitIcon = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4"
      {...stroke}
      strokeWidth={2.2}
    />
  </Icon>
);

// CaptionsIcon is "CC" cut out of a rounded box (a mask, so the letters show
// the video through them in any bar colour).
export function CaptionsIcon(p: IconProps & {'data-on'?: string}) {
  const id = useId();
  return (
    <Icon {...p}>
      <mask id={id}>
        <rect x="2" y="4.5" width="20" height="15" rx="3.2" fill="#fff" />
        <path
          d="M10.6 10.1a2.3 2.3 0 1 0 0 3.8M17.4 10.1a2.3 2.3 0 1 0 0 3.8"
          fill="none"
          stroke="#000"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </mask>
      <rect x="2" y="4.5" width="20" height="15" rx="3.2" mask={`url(#${id})`} />
    </Icon>
  );
}

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" {...stroke} strokeWidth={2.2} />
  </Icon>
);

export const ChevronIcon = ({back, ...p}: IconProps & {back?: boolean}) => (
  <Icon {...p}>
    <path d={back ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} {...stroke} />
  </Icon>
);

// SpinnerIcon is a ring with an accent arc (CSS turns it).
export const SpinnerIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.2"
      strokeWidth="2"
    />
    <path
      d="M12 2a10 10 0 0 1 10 10"
      fill="none"
      stroke="var(--player-accent, currentColor)"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </Icon>
);

// AskAiIcon is Ask AI's mark: a filled four-point sparkle with a small one.
export const AskAiIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 3.3a.6.6 0 0 1 1.13 0l1.5 4.17a2 2 0 0 0 1.2 1.2l4.17 1.5a.6.6 0 0 1 0 1.13l-4.17 1.5a2 2 0 0 0-1.2 1.2l-1.5 4.17a.6.6 0 0 1-1.13 0l-1.5-4.17a2 2 0 0 0-1.2-1.2L3.73 11.3a.6.6 0 0 1 0-1.13l4.17-1.5a2 2 0 0 0 1.2-1.2l1.5-4.17Z" />
    <path d="M18.3 15.2a.35.35 0 0 1 .66 0l.6 1.66c.08.22.25.4.48.48l1.66.6a.35.35 0 0 1 0 .66l-1.66.6a.8.8 0 0 0-.48.48l-.6 1.66a.35.35 0 0 1-.66 0l-.6-1.66a.8.8 0 0 0-.48-.48l-1.66-.6a.35.35 0 0 1 0-.66l1.66-.6a.8.8 0 0 0 .48-.48l.6-1.66Z" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" {...stroke} />
  </Icon>
);

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" {...stroke} />
  </Icon>
);
