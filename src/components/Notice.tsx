import { useEffect, type ReactNode } from "react";
import { Toast, ToastBody, ToastTitle, Toaster, useToastController } from "@fluentui/react-components";

export type NoticeIntent = "info" | "success" | "warning" | "error";

const TOASTER_ID = "app-notices";

// Toaster 只能用 hook 派发，这里存下派发函数，让页面里的事件处理函数随时能调用。
let dispatch: ((content: ReactNode, options?: { intent: NoticeIntent }) => void) | null = null;

/**
 * 右上角的轻提示，对应源项目的 InfoBar。
 * title 必给，message 是可选的说明行。
 */
export function notice(intent: NoticeIntent, title: string, message?: string): void {
  dispatch?.(
    <Toast>
      <ToastTitle>{title}</ToastTitle>
      {message ? <ToastBody>{message}</ToastBody> : null}
    </Toast>,
    { intent },
  );
}

/** 挂在 FluentProvider 里面，全应用放一个。 */
export function NoticeHost() {
  const { dispatchToast } = useToastController(TOASTER_ID);
  useEffect(() => {
    dispatch = dispatchToast;
    return () => {
      dispatch = null;
    };
  }, [dispatchToast]);
  return <Toaster toasterId={TOASTER_ID} position="top-end" />;
}
