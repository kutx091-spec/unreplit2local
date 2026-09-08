import * as React from "react"
import { cn } from "@/lib/utils"

const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  return <div className="fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]">{children}</div>
}

export function Toaster() {
  // Mock toaster for now
  return <ToastProvider><></></ToastProvider>
}
