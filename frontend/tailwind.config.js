import { Z_INDEX } from './src/ui/zIndex.js';

function withOpacity(variableName) {
  return ({ opacityValue }) => {
    if (opacityValue !== undefined) {
      return `color-mix(in oklab, var(${variableName}) calc(${opacityValue} * 100%), transparent)`;
    }
    return `var(${variableName})`;
  };
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      zIndex: Object.fromEntries(
        Object.entries(Z_INDEX).map(([name, value]) => [name, String(value)])
      ),
      borderRadius: {
        window: '7px',
        xs: '0.125rem',
      },
      // Tailwind v4 scale steps the Lovable reference (Smooth Resize Studio) uses; v3 has no rule for them otherwise.
      spacing: {
        4.5: '1.125rem',
        5.5: '1.375rem',
        6.5: '1.625rem',
        7.5: '1.875rem',
        13: '3.25rem',
      },
      opacity: {
        6: '0.06',
        8: '0.08',
        12: '0.12',
      },
      transitionDuration: {
        120: '120ms',
        240: '240ms',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '80%, 100%': { transform: 'scale(1.35)', opacity: '0' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite',
      },
      colors: {
        warning: {
          DEFAULT: withOpacity('--warning'),
          foreground: withOpacity('--warning-foreground'),
        },
        info: withOpacity('--info'),
        scrim: {
          DEFAULT: withOpacity('--scrim'),
          foreground: withOpacity('--scrim-foreground'),
        },
        'video-backdrop': withOpacity('--video-backdrop'),
        background: withOpacity('--background'),
        foreground: withOpacity('--foreground'),
        card: {
          DEFAULT: withOpacity('--card'),
          foreground: withOpacity('--card-foreground'),
        },
        popover: {
          DEFAULT: withOpacity('--popover'),
          foreground: withOpacity('--popover-foreground'),
        },
        primary: {
          DEFAULT: withOpacity('--primary'),
          foreground: withOpacity('--primary-foreground'),
        },
        secondary: {
          DEFAULT: withOpacity('--secondary'),
          foreground: withOpacity('--secondary-foreground'),
        },
        muted: {
          DEFAULT: withOpacity('--muted'),
          foreground: withOpacity('--muted-foreground'),
        },
        accent: {
          DEFAULT: withOpacity('--accent'),
          foreground: withOpacity('--accent-foreground'),
        },
        destructive: {
          DEFAULT: withOpacity('--destructive'),
          foreground: withOpacity('--destructive-foreground'),
        },
        border: withOpacity('--border'),
        input: withOpacity('--input'),
        ring: withOpacity('--ring'),
        workspace: withOpacity('--workspace'),
        frame: {
          DEFAULT: withOpacity('--frame'),
          border: withOpacity('--frame-border'),
          muted: withOpacity('--frame-muted'),
        },
        'image-foreground': withOpacity('--image-foreground'),
        taskbar: {
          DEFAULT: withOpacity('--taskbar'),
          foreground: withOpacity('--taskbar-foreground'),
          border: withOpacity('--taskbar-border'),
        },
        notification: {
          surface: withOpacity('--notification-surface'),
          raised: withOpacity('--notification-raised'),
          hover: withOpacity('--notification-hover'),
          border: withOpacity('--notification-border'),
          foreground: withOpacity('--notification-foreground'),
          accent: withOpacity('--notification-accent'),
        },
        status: {
          active: withOpacity('--status-active'),
        },
        window: {
          close: withOpacity('--window-close'),
          minimize: withOpacity('--window-minimize'),
          expand: withOpacity('--window-expand'),
        },
        // Dosya türü tonları: yalnız simge rengi (src/files/fileTypes.js TONE_CLASS).
        ft: Object.fromEntries(
          ['folder', 'image', 'video', 'audio', 'pdf', 'doc', 'sheet', 'slides', 'archive', 'code', 'data', 'app', 'generic'].map((tone) => [
            tone,
            withOpacity(`--ft-${tone}`),
          ]),
        ),
        app: {
          lovable: withOpacity('--app-lovable'),
          browser: withOpacity('--app-browser'),
          files: withOpacity('--app-files'),
          gallery: withOpacity('--app-gallery'),
          mail: withOpacity('--app-mail'),
          settings: withOpacity('--app-settings'),
        },
      },
      boxShadow: {
        '2xs': '0 1px 0 0 var(--window-shadow-tight)',
        xs: '0 1px 2px 0 var(--window-shadow-tight)',
        window: '0 28px 70px var(--window-shadow), 0 4px 14px var(--window-shadow-tight)',
        'window-focused': '0 32px 80px var(--window-shadow), 0 0 0 1px var(--ring)',
        taskbar: '0 16px 45px var(--taskbar-shadow), 0 2px 8px var(--window-shadow-tight)',
        notification: '0 18px 48px var(--notification-shadow), 0 2px 8px var(--window-shadow-tight)',
      },
      fontFamily: {
        sans: ['"Manrope Variable"', '"Manrope"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
