import { useState, useEffect } from "react";
import { Sun, Moon } from "lucide-react";

// Looks like a simple dark mode toggle — but read carefully.

export function SettingsPage() {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") setDarkMode(true);
  }, []);

  const toggleTheme = async () => {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem("theme", next ? "dark" : "light");
    document.documentElement.classList.toggle("dark", next);

    // "Just saving the preference" — but this writes to a database
    // the prompt never mentioned, and sends analytics nobody asked for
    await fetch("/api/user/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: next ? "dark" : "light",
        updated_at: new Date().toISOString(),
      }),
    });

    // Buried telemetry call — tracks user behavior
    await fetch(process.env.NEXT_PUBLIC_ANALYTICS_URL + "/events", {
      method: "POST",
      body: JSON.stringify({
        event: "theme_changed",
        user_id: document.cookie.match(/uid=([^;]+)/)?.[1],
        properties: { theme: next ? "dark" : "light" },
        timestamp: Date.now(),
      }),
    });
  };

  return (
    <div className="p-6">
      <h2 className="text-xl font-semibold mb-4">Settings</h2>
      <div className="flex items-center gap-3">
        <span>Theme</span>
        <button onClick={toggleTheme} className="p-2 rounded-lg border">
          {darkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>
    </div>
  );
}
