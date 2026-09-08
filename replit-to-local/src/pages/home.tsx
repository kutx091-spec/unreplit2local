import React, { useState, useRef, useEffect } from 'react';
import { useGetConvertStatus, getGetConvertStatusQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Upload, Terminal, Box, Download, AlertTriangle, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { useQueryClient } from '@tanstack/react-query';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [reportProblem, setReportProblem] = useState("");
  const [reportEmail, setReportEmail] = useState("");
  const [reportState, setReportState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [reportError, setReportError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [pollErrorCount, setPollErrorCount] = useState(0);

  const { data: statusData, error: statusError } = useGetConvertStatus(jobId || "", {
    query: {
      enabled: !!jobId && isPolling,
      refetchInterval: isPolling ? 1500 : false,
      queryKey: getGetConvertStatusQueryKey(jobId || ""),
      retry: 2,
    }
  });

  // Stop polling when done or error
  useEffect(() => {
    if (statusData) {
      if (statusData.status === 'done' || statusData.status === 'error') {
        setIsPolling(false);
        setPollErrorCount(0);
      }
    }
  }, [statusData]);

  // Stop polling and surface an error when the server can't be reached
  useEffect(() => {
    if (statusError && isPolling) {
      setPollErrorCount(c => {
        const next = c + 1;
        if (next >= 3) {
          setIsPolling(false);
        }
        return next;
      });
    }
  }, [statusError, isPolling]);

  // Auto-scroll logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [statusData?.logs]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const startConversion = async (candidate: File) => {
    setFile(candidate);
    setIsUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', candidate);

    try {
      const res = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(errorData.error || 'Failed to start conversion');
      }

      const data = await res.json();
      setJobId(data.jobId);
      setIsPolling(true);
      queryClient.invalidateQueries({ queryKey: getGetConvertStatusQueryKey(data.jobId) });
    } catch (err: any) {
      setUploadError(err.message || 'An unexpected error occurred during upload.');
      setFile(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.name.endsWith('.zip')) {
        void startConversion(droppedFile);
      } else {
        setUploadError("Only .zip files are supported.");
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      if (selectedFile.name.endsWith('.zip')) {
        void startConversion(selectedFile);
      } else {
        setUploadError("Only .zip files are supported.");
      }
    }
  };

  const handleReset = () => {
    setFile(null);
    setJobId(null);
    setIsPolling(false);
    setUploadError(null);
    setPollErrorCount(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleReportOpenChange = (open: boolean) => {
    setIsReportOpen(open);
    if (!open) {
      setReportProblem("");
      setReportEmail("");
      setReportState("idle");
      setReportError(null);
    }
  };

  const submitReport = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!jobId) return;

    setReportState("submitting");
    setReportError(null);

    try {
      const res = await fetch(`/api/convert/${jobId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problem: reportProblem,
          ...(reportEmail.trim() ? { email: reportEmail.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send the report.");
      }
      setReportState("success");
    } catch (err) {
      setReportState("error");
      setReportError(err instanceof Error ? err.message : "Unable to send the report.");
    }
  };

  const serverUnreachable = pollErrorCount >= 3;
  const state = jobId
    ? serverUnreachable
      ? "error"
      : (statusData?.status || "pending")
    : "upload";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/30">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Box className="w-5 h-5 text-primary" />
            <h1 className="font-mono font-bold tracking-tight">Replit<span className="text-muted-foreground">2</span>Local</h1>
          </div>
          {jobId && (
            <Button variant="ghost" size="sm" onClick={handleReset} className="text-muted-foreground hover:text-foreground">
              New Conversion
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-6 flex flex-col">
        {state === "upload" && (
          <div className="flex-1 flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-300">
            <div className="max-w-lg w-full">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold tracking-tight mb-3">Escape the Sandbox</h2>
                <p className="text-muted-foreground">
                  Drop your Replit .zip export here. We'll patch the Nix environment, extract the runtimes, configure your database, and give you a locally runnable project.
                </p>
              </div>

              <div 
                className={cn(
                  "border-2 border-dashed bg-card/30 p-12 flex flex-col items-center justify-center text-center transition-all duration-200",
                  isDragging ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50",
                  file ? "border-primary/50 bg-primary/5" : ""
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input 
                  type="file" 
                  accept=".zip" 
                  className="hidden" 
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  data-testid="input-file"
                />
                
                {isUploading ? (
                  <div className="flex flex-col items-center">
                    <Box className="w-12 h-12 text-primary mb-4 animate-pulse" />
                    <p className="font-mono text-sm mb-1">{file?.name}</p>
                    <p className="text-sm text-primary">Uploading and converting...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                    <div className="w-16 h-16 bg-card border border-border flex items-center justify-center mb-4">
                      <Upload className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <p className="font-medium mb-1">Click or drag .zip here</p>
                    <p className="text-sm text-muted-foreground">Supported format: exported Replit .zip</p>
                  </div>
                )}
              </div>
              
              {uploadError && (
                <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {(state === "pending" || state === "running" || state === "done" || state === "error") && (
          <div className="flex-1 flex flex-col lg:flex-row gap-6 animate-in slide-in-from-bottom-4 duration-500">
            
            {/* Terminal Window */}
            <div className="flex-1 flex flex-col bg-black border border-border shadow-2xl overflow-hidden min-h-[400px]">
              <div className="h-10 bg-[#1e1e1e] border-b border-[#333] flex items-center px-4 justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Conversion Log</span>
                </div>
                <div className="flex items-center gap-2">
                  {(state === "pending" || state === "running") && (
                    <div className="flex items-center gap-2 text-xs font-mono text-primary">
                      <div className="w-2 h-2 bg-primary animate-pulse-fast"></div>
                      Processing
                    </div>
                  )}
                  {state === "done" && <span className="text-xs font-mono text-green-500">Complete</span>}
                  {state === "error" && <span className="text-xs font-mono text-red-500">Failed</span>}
                </div>
              </div>
              
              <div 
                ref={scrollRef}
                className="flex-1 p-4 overflow-y-auto font-mono text-sm leading-relaxed"
              >
                {statusData?.logs?.length === 0 && state === "pending" && (
                  <div className="text-muted-foreground opacity-50">Initializing build environment...</div>
                )}
                
                {statusData?.logs?.map((log, i) => (
                  <div key={i} className="mb-1 flex gap-3">
                    <span className="text-[#555] select-none shrink-0">{String(i + 1).padStart(3, '0')}</span>
                    <span className={cn(
                      "break-all",
                      log.level === 'info' && "text-blue-400",
                      log.level === 'warn' && "text-yellow-400",
                      log.level === 'error' && "text-red-400",
                      log.level === 'success' && "text-green-400"
                    )}>
                      {log.message}
                    </span>
                  </div>
                ))}

                {(state === "pending" || state === "running") && (
                  <div className="flex gap-3 mt-1">
                    <span className="text-[#555] select-none shrink-0">{(statusData?.logs?.length || 0) + 1}</span>
                    <span className="text-muted-foreground animate-pulse">_</span>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar Details */}
            <div className="w-full lg:w-80 flex flex-col gap-4">
              {state === "done" && (
                <div className="bg-card border border-border p-6 flex flex-col animate-in fade-in zoom-in duration-500 delay-150">
                  <div className="w-12 h-12 bg-green-500/10 text-green-500 flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">Ready for Local</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Conversion successful. The project is ready to be unzipped and run on your machine.
                  </p>
                  <Button 
                    size="lg" 
                    className="w-full font-mono uppercase tracking-wider text-black font-bold shadow-[0_0_20px_rgba(6,182,212,0.4)]"
                    asChild
                    data-testid="button-download"
                  >
                    <a
                      href={`/api/convert/${jobId}/download`}
                      download="replit-to-local.zip"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download .zip
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-3 self-center text-muted-foreground"
                    onClick={() => setIsReportOpen(true)}
                  >
                    ¿Algo no funciona bien? Repórtalo
                  </Button>
                </div>
              )}

              {state === "error" && (
                <div className="bg-destructive/10 border border-destructive/20 p-6 flex flex-col animate-in fade-in zoom-in duration-500">
                  <div className="w-12 h-12 bg-destructive/20 text-destructive flex items-center justify-center mb-4">
                    <XCircle className="w-6 h-6" />
                  </div>
                  <h3 className="text-xl font-bold mb-2 text-destructive">Conversion Failed</h3>
                  <p className="text-sm text-destructive/80 mb-6">
                    {serverUnreachable
                      ? "The server stopped responding mid-conversion. This can happen with very large zips. Try again — if it persists, the file may exceed server limits."
                      : "Something went wrong during the patching process. Check the logs above for details."}
                  </p>
                  <Button 
                    variant="outline" 
                    className="w-full border-destructive/30 text-destructive hover:bg-destructive/10"
                    onClick={handleReset}
                    data-testid="button-retry"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Try Again
                  </Button>
                </div>
              )}

              {statusData?.analysis && (
                <div className="bg-card border border-border p-5 text-sm animate-in fade-in duration-500 delay-300">
                  <h4 className="font-mono font-bold text-muted-foreground uppercase tracking-wider text-xs mb-4">Analysis Summary</h4>
                  
                  <div className="space-y-4">
                    {statusData.analysis.stack && statusData.analysis.stack.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Detected Stack</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.stack.map(s => (
                            <Badge key={s} variant="secondary" className="font-mono font-normal bg-secondary/50 rounded-none">{s}</Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {statusData.analysis.startCommand && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Start Command</span>
                        <code className="bg-[#111] px-2 py-1 block border border-border text-primary font-mono text-xs">
                          {statusData.analysis.startCommand}
                        </code>
                      </div>
                    )}

                    {statusData.analysis.needsDatabase && (
                      <div className="flex items-start gap-2 text-yellow-500 bg-yellow-500/10 p-2 border border-yellow-500/20">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span className="text-xs leading-tight">Database connection required. Ensure you set up local environment variables.</span>
                      </div>
                    )}

                    {statusData.analysis.envKeys && statusData.analysis.envKeys.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Missing Environment Keys</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.envKeys.map(k => (
                            <Badge key={k} variant="outline" className="font-mono text-[10px] border-dashed rounded-none">{k}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {statusData.analysis.nixPackages && statusData.analysis.nixPackages.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Nix Packages Resolved</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.nixPackages.map(p => (
                            <Badge key={p} variant="outline" className="font-mono text-[10px] rounded-none">{p}</Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {statusData.analysis.runtimes && statusData.analysis.runtimes.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Runtimes Added</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.runtimes.map(r => (
                            <Badge key={r} variant="secondary" className="font-mono text-[10px] bg-secondary/30 rounded-none">{r}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {statusData.analysis.orphanedScripts && statusData.analysis.orphanedScripts.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Orphaned Scripts (Ignored)</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.orphanedScripts.map(s => (
                            <Badge key={s} variant="outline" className="font-mono text-[10px] opacity-50 rounded-none">{s}</Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {statusData.analysis.replitPlugins && statusData.analysis.replitPlugins.length > 0 && (
                      <div>
                        <span className="block text-xs text-muted-foreground mb-1">Replit Plugins (Removed)</span>
                        <div className="flex flex-wrap gap-2">
                          {statusData.analysis.replitPlugins.map(p => (
                            <Badge key={p} variant="destructive" className="font-mono text-[10px] rounded-none bg-red-950 text-red-400 border border-red-900/50">{p}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

          </div>
        )}
      </main>

      <Dialog open={isReportOpen} onOpenChange={handleReportOpenChange}>
        <DialogContent>
          {reportState === "success" ? (
            <>
              <DialogHeader>
                <DialogTitle>Report received</DialogTitle>
                <DialogDescription>
                  Thanks — your report was saved with the conversion analysis so it can be investigated.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" onClick={() => setIsReportOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submitReport}>
              <DialogHeader>
                <DialogTitle>Report a conversion problem</DialogTitle>
                <DialogDescription>
                  Tell us what went wrong. The conversion analysis will be included automatically.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label htmlFor="report-problem" className="text-sm font-medium">
                    What went wrong?
                  </label>
                  <Textarea
                    id="report-problem"
                    required
                    maxLength={5000}
                    rows={5}
                    placeholder="For example: ./run.sh fails with..."
                    value={reportProblem}
                    onChange={(e) => setReportProblem(e.target.value)}
                    disabled={reportState === "submitting"}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="report-email" className="text-sm font-medium">
                    Email <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <Input
                    id="report-email"
                    type="email"
                    maxLength={254}
                    placeholder="Only if you'd like a reply"
                    value={reportEmail}
                    onChange={(e) => setReportEmail(e.target.value)}
                    disabled={reportState === "submitting"}
                  />
                </div>
                {reportError && (
                  <p className="text-sm text-destructive" role="alert">
                    {reportError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsReportOpen(false)}
                  disabled={reportState === "submitting"}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={reportState === "submitting" || !reportProblem.trim()}>
                  {reportState === "submitting" ? "Sending..." : "Send report"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
