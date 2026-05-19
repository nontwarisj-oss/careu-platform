"use client";

// Password input with a show/hide eye toggle. Mobile-friendly — helps staff
// catch Thai/English keyboard mistakes before submitting. The plaintext value
// is only ever revealed inside this field, on explicit user action.

import { useState } from "react";

type PasswordInputProps = {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  /** Page input styling. The eye-button padding (pr-11) is appended here. */
  className?: string;
};

const DEFAULT_INPUT =
  "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500";

export function PasswordInput({
  value,
  onChange,
  id,
  placeholder,
  autoComplete,
  minLength,
  required,
  className,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        required={required}
        className={`${className ?? DEFAULT_INPUT} pr-11`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
        title={visible ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-green-700"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-5 h-5"
          fill="currentColor"
          aria-hidden
        >
          {visible ? (
            <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
          ) : (
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" />
          )}
        </svg>
      </button>
    </div>
  );
}

export default PasswordInput;
