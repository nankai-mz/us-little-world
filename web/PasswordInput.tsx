import { useState, type ComponentProps } from "react";

export function PasswordInput(props: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={visible ? "text" : "password"} />
      <button type="button" className="text-button" aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible} onClick={() => setVisible((value) => !value)}>
        {visible ? "隐藏" : "显示"}
      </button>
    </span>
  );
}
