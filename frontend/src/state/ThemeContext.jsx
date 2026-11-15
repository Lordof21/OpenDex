import React, { createContext, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext(undefined);
const STORAGE_KEY = 'theme';

// Read synchronously: the first render already knows the saved theme (public/theme-init.js applied the class before the first
// paint; this keeps React's state in step with it instead of starting at 'light' and correcting itself after mount).
function readSavedTheme() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readSavedTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage blocked: the choice lasts for this run only */
    }
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isDark: theme === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
