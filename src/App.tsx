import React, { useState, useRef, useEffect } from "react";
import { Copy, Search, CheckCircle2, ChevronRight, Bot, Volume2, Mic, MicOff, ExternalLink, Settings, X, RotateCcw, Pause, Play, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";

interface BasicLink {
  url: string;
  text: string;
}

const defaultUrl = "https://www.churchofjesuschrist.org/study/manual/general-handbook?lang=eng";

class GaplessPCMPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime: number = 0;
  private sampleRate: number = 24000;

  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
  }

  init() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.sampleRate,
      });
      this.nextStartTime = this.audioCtx.currentTime;
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
  }

  playChunk(base64Data: string) {
    this.init();
    if (!this.audioCtx) return;

    // Decode base64 to Uint8Array
    const binary = window.atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Convert 16-bit PCM (little-endian) to float32
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create an AudioBuffer
    const audioBuffer = this.audioCtx.createBuffer(1, float32Array.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    // Schedule playback
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const currentTime = this.audioCtx.currentTime;
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime + 0.05; // small buffer
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  stop() {
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
  }
}

export default function App() {
  const [url, setUrl] = useState(defaultUrl);
  
  // Scanning & Links State
  const [scanLoading, setScanLoading] = useState(false);
  const [rawLinks, setRawLinks] = useState<BasicLink[]>([]);
  const [scanned, setScanned] = useState(false);
  const [copied, setCopied] = useState(false);
  
  // Discussion Leader Wizard State
  const [guideStep, setGuideStep] = useState(0); // 0 = Inbjudan, 1 = Hämta, 2 = NotebookLM, 3 = Chatta, 4 = Gemini Live
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [customReply, setCustomReply] = useState("");
  const [chatLog, setChatLog] = useState<{ sender: "leader" | "user"; text: string; timestamp: Date }[]>([]);
  
  // Advanced panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [error, setError] = useState("");

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Gemini Live state
  const [liveConnected, setLiveConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<GaplessPCMPlayer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const speakingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);

  const toggleMute = () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    isMutedRef.current = nextMute;
    setChatLog(prev => [
      ...prev,
      {
        sender: "leader",
        text: nextMute ? "⏸️ Röstsamtalet är tillfälligt pausat (mikrofonen är avstängd)." : "▶️ Röstsamtalet är återupptaget (mikrofonen är på).",
        timestamp: new Date()
      }
    ]);
  };

  useEffect(() => {
    return () => {
      stopLiveSession();
      if (speakingTimeoutRef.current) {
        clearTimeout(speakingTimeoutRef.current);
      }
    };
  }, []);

  const startLiveSession = async (initialText?: string) => {
    if (wsRef.current) return;
    setError("");

    // Reset mute state when starting a fresh session
    setIsMuted(false);
    isMutedRef.current = false;

    try {
      if (!playerRef.current) {
        playerRef.current = new GaplessPCMPlayer(24000);
      }
      playerRef.current.init();

      // 1. Get microphone access synchronously in direct click event context
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      } catch (micErr: any) {
        console.error("Microphone permission failed:", micErr);
        setError("Kunde inte starta mikrofonen. Vänligen tillåt mikrofonåtkomst i din webbläsare.");
        return;
      }

      // 2. Initialize and resume AudioContext synchronously in click event context
      let inputAudioCtx: AudioContext;
      try {
        inputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        inputAudioCtxRef.current = inputAudioCtx;
        if (inputAudioCtx.state === "suspended") {
          await inputAudioCtx.resume();
        }
      } catch (audioCtxErr: any) {
        console.error("AudioContext initialization failed:", audioCtxErr);
        setError("Kunde inte starta ljudsystemet.");
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      
      // Netlify & external deploy resiliency: fallback to the live Cloud Run backend!
      const isExternalHost = !window.location.host.includes(".run.app") && window.location.host !== "localhost:3000";
      const wsHost = isExternalHost ? "ais-pre-csqchpqaru5ypc2ijmdpbg-52213981999.europe-west2.run.app" : window.location.host;
      const wsUrl = `${protocol}//${wsHost}/live-ws?apiKey=${encodeURIComponent(apiKey)}`;
      
      console.log("Connecting to bridge:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setLiveConnected(true);
        setIsListening(true);
        setError("");
        
        // If there's an initial text instruction, send it immediately upon connection
        if (initialText) {
          ws.send(JSON.stringify({ text: `Vänligen säg eller vägled användaren genom detta steg nu: ${initialText}` }));
        } else {
          // Welcome prompt
          ws.send(JSON.stringify({ text: "Vänligen hälsa på användaren på svenska och fråga om de vill starta processen att tala med handboken!" }));
        }
        
        try {
          const source = inputAudioCtx.createMediaStreamSource(stream);
          const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
          audioProcessorRef.current = processor;

          source.connect(processor);
          processor.connect(inputAudioCtx.destination);

          processor.onaudioprocess = (e) => {
            // Respect pause/mute state
            if (isMutedRef.current) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const buffer = new ArrayBuffer(inputData.length * 2);
            const view = new DataView(buffer);
            let offset = 0;
            for (let i = 0; i < inputData.length; i++, offset += 2) {
              let s = Math.max(-1, Math.min(1, inputData[i]));
              view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            }

            let binary = "";
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = window.btoa(binary);

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ audio: base64 }));
            }
          };
        } catch (procErr: any) {
          console.error("Audio processing setup failed:", procErr);
          setError("Kunde inte starta röstprocessorn.");
          stopLiveSession();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.type === "error") {
            setError(msg.error);
            stopLiveSession();
          } else if (msg.type === "audio") {
            setIsSpeaking(true);
            if (speakingTimeoutRef.current) {
              clearTimeout(speakingTimeoutRef.current);
            }
            speakingTimeoutRef.current = setTimeout(() => {
              setIsSpeaking(false);
            }, 1000);

            if (playerRef.current) {
              playerRef.current.playChunk(msg.audio);
            }
          } else if (msg.type === "text") {
            // Append streaming words to the chat log dynamically!
            setChatLog((prev) => {
              if (prev.length === 0) {
                return [{ sender: "leader", text: msg.text, timestamp: new Date() }];
              }
              const lastMsg = prev[prev.length - 1];
              if (lastMsg.sender === "leader") {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...lastMsg,
                  text: lastMsg.text + msg.text,
                };
                return updated;
              } else {
                return [...prev, { sender: "leader", text: msg.text, timestamp: new Date() }];
              }
            });
          } else if (msg.type === "interrupted") {
            console.log("Interruption received from Gemini Live!");
            setIsSpeaking(false);
            if (playerRef.current) {
              playerRef.current.stop();
              playerRef.current = new GaplessPCMPlayer(24000);
              playerRef.current.init();
            }
          } else if (msg.type === "toolCall") {
            console.log("Tool call received from Gemini Live:", msg);
            if (msg.name === "goToStep") {
              const targetStep = Number(msg.args.step);
              if (targetStep >= 0 && targetStep <= 4) {
                setGuideStep(targetStep);
                setChatLog((prev) => [
                  ...prev,
                  {
                    sender: "leader",
                    text: `🔄 Röststyrt kommando: Går till steg ${targetStep}.`,
                    timestamp: new Date()
                  }
                ]);
                
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "toolResponse",
                    id: msg.id,
                    response: { success: true, message: `Successfully changed step to ${targetStep}` }
                  }));
                }
              } else {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "toolResponse",
                    id: msg.id,
                    response: { success: false, error: "Step must be between 0 and 4" }
                  }));
                }
              }
            } else if (msg.name === "openWebpage") {
              const url = msg.args.url;
              try {
                const opened = window.open(url, "_blank");
                setChatLog((prev) => [
                  ...prev,
                  {
                    sender: "leader",
                    text: `🌐 Röststyrt kommando: Öppnar webbsida i ny flik: ${url}`,
                    timestamp: new Date()
                  }
                ]);
                
                if (!opened) {
                  setChatLog((prev) => [
                    ...prev,
                    {
                      sender: "leader",
                      text: `⚠️ Popup-blockerare hindrade sidan från att öppnas. Klicka här för att öppna den manuellt: ${url}`,
                      timestamp: new Date()
                    }
                  ]);
                }
                
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "toolResponse",
                    id: msg.id,
                    response: { success: true, opened: !!opened }
                  }));
                }
              } catch (err: any) {
                console.error("Failed to open webpage via tool:", err);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "toolResponse",
                    id: msg.id,
                    response: { success: false, error: err.message }
                  }));
                }
              }
            }
          }
        } catch (err) {
          console.error("Failed to parse message from Live WS:", err);
        }
      };

      ws.onclose = () => {
        console.log("WebSocket connection closed.");
        setLiveConnected(false);
        setIsListening(false);
        setIsSpeaking(false);
        wsRef.current = null;
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setError("Kunde inte ansluta till Gemini Live. Kontrollera din internetanslutning eller API-nyckel.");
        stopLiveSession();
      };

    } catch (e: any) {
      console.error("Error setting up Gemini Live:", e);
      setError(`Kunde inte initiera röstanslutning: ${e.message}`);
    }
  };

  const stopLiveSession = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      streamRef.current = null;
    }

    if (audioProcessorRef.current) {
      try {
        audioProcessorRef.current.disconnect();
      } catch (e) {}
      audioProcessorRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      try {
        inputAudioCtxRef.current.close();
      } catch (e) {}
      inputAudioCtxRef.current = null;
    }

    if (playerRef.current) {
      try {
        playerRef.current.stop();
      } catch (e) {}
      playerRef.current = null;
    }

    setLiveConnected(false);
    setIsListening(false);
    setIsSpeaking(false);
  };

  // Auto scroll to bottom of conversation log
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatLog]);

  // Handle welcome greeting on start
  useEffect(() => {
    setChatLog([
      {
        sender: "leader",
        text: "Hej! Välkommen till H - Tala med handboken. Jag är din röststyrda diskussionsledare drivs av Gemini Live. Klicka på den stora knappen 'Ja, Tala med Handboken (starta röstsamtal)' nedan för att börja prata med mig på svenska!",
        timestamp: new Date()
      }
    ]);
  }, []);

  // Conversational response logic
  const handleUserResponse = (text: string) => {
    if (!text.trim()) return;
    
    const newUserMsg = { sender: "user" as const, text, timestamp: new Date() };
    setChatLog(prev => [...prev, newUserMsg]);
    setCustomReply("");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ text }));
    } else {
      setChatLog(prev => [...prev, {
        sender: "leader",
        text: "Klicka på den stora knappen 'Ja, Tala med Handboken (starta röstsamtal)' ovan för att starta röststyrningen med Gemini Live och prata eller skriva med mig!",
        timestamp: new Date()
      }]);
    }
  };

  // STOP (Reset) action
  const handleStop = () => {
    stopLiveSession();
    setGuideStep(0);
    setIsMuted(false);
    isMutedRef.current = false;
    setChatLog([{ 
      sender: "leader", 
      text: "⏱️ Diskussionsledaren har nollställts. Klicka på 'Ja, Tala med Handboken (starta röstsamtal)' nedan för att börja om och prata med mig på svenska!", 
      timestamp: new Date() 
    }]);
  };

  // Link Extraction Scraper with Multi-Proxy Resilient Fallback for Netlify
  const handleScan = async () => {
    const scanUrl = url.trim() || defaultUrl;
    
    setScanLoading(true);
    setError("");
    setRawLinks([]);
    setScanned(false);
    
    let links: BasicLink[] = [];
    
    try {
      // Netlify & external deploy resiliency: fallback to the live Cloud Run backend API!
      const isExternalHost = !window.location.host.includes(".run.app") && window.location.host !== "localhost:3000";
      const apiBase = isExternalHost ? "https://ais-pre-csqchpqaru5ypc2ijmdpbg-52213981999.europe-west2.run.app" : "";

      // 1. Attempt local Node/Express scraper proxy first
      const response = await fetch(`${apiBase}/api/extract-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scanUrl }),
      });
      
      if (response.ok) {
        const data = await response.json();
        links = data.links || [];
      } else {
        throw new Error("Express service unavailable");
      }
    } catch (err: any) {
      console.log("Local Express endpoint failed, attempting client-side resilient CORS fallback...", err);
      
      // Resilient proxy fallbacks
      const fallbackProxies = [
        (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        (u: string) => `https://thingproxy.freeboard.io/fetch/${u}`
      ];
      
      let html = "";
      let success = false;
      let activeProxyIdx = 0;
      
      for (const getProxyUrl of fallbackProxies) {
        try {
          const proxyUrl = getProxyUrl(scanUrl);
          console.log(`Connecting to fallback proxy [${activeProxyIdx}]: ${proxyUrl}`);
          const response = await fetch(proxyUrl);
          if (response.ok) {
            html = await response.text();
            success = true;
            break;
          }
        } catch (proxyErr) {
          console.warn(`Proxy index ${activeProxyIdx} connection failed:`, proxyErr);
        }
        activeProxyIdx++;
      }
      
      if (!success) {
        setError("Kunde inte ansluta till någon tillgänglig nätverksproxy för att hämta länkarna. Se till att du är ansluten till internet.");
        setScanLoading(false);
        return;
      }
      
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const anchors = doc.querySelectorAll("a");
        const seen = new Set<string>();
        const extracted: BasicLink[] = [];
        
        anchors.forEach(a => {
          const href = a.getAttribute("href");
          if (!href) return;
          try {
            const urlObj = new URL(href, scanUrl);
            urlObj.hash = "";
            const absoluteUrl = urlObj.href;
            const text = a.textContent?.trim() || "";
            
            if (!seen.has(absoluteUrl) && (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://"))) {
              seen.add(absoluteUrl);
              extracted.push({ url: absoluteUrl, text: text || "Handbokskälla" });
            }
          } catch (e) {}
        });
        links = extracted;
      } catch (parseErr: any) {
        setError(`Ett fel uppstod vid analys av handbokens HTML: ${parseErr.message}`);
        setScanLoading(false);
        return;
      }
    }

    if (links.length > 0) {
      // Sort and keep up to 44 handbook sources
      const handbookLinks = links.filter(l => l.url.includes("handbook") || l.url.includes("/study/manual/"));
      const finalLinks = handbookLinks.length > 0 ? handbookLinks : links;
      
      // Limit to 44 links strictly as requested
      const cappedLinks = finalLinks.slice(0, 44);
      setRawLinks(cappedLinks);
      setScanned(true);

      // Perform automatic clipboard copy of ALL 44 links immediately!
      try {
        const urlsText = cappedLinks.map(l => l.url).join("\n");
        await navigator.clipboard.writeText(urlsText);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch (copyErr) {
        console.warn("Auto clipboard copy failed due to browser sandbox restrictions", copyErr);
      }

      // Automatically advance to Step 2
      setGuideStep(2);
      const completionText = `Underbart! Jag har framgångsrikt hämtat alla ${cappedLinks.length} källor och lagt till dem i ditt urklipp. Klicka nu på knappen '2. ÖPPNA NOTEBOOKLM'. Väl där, klicka på 'Skapa ny notebook', välj 'Webbplats' och klistra in länkarna från ditt urklipp. Säg till mig när du är klar, så fortsätter vi!`;
      
      setChatLog(prev => [
        ...prev, 
        { sender: "leader", text: completionText, timestamp: new Date() }
      ]);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ text: `Användaren har nu hämtat länkarna. Vänligen säg detta nu: ${completionText}` }));
      } else {
        startLiveSession(completionText);
      }

    } else {
      setError("Inga giltiga handbokskällor kunde hittas på sidan.");
    }
    setScanLoading(false);
  };

  return (
    <div className="h-screen w-full bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900 flex flex-col overflow-hidden">
      
      {/* Header with Title and Minimalist Gear */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-black text-sm shadow-md animate-pulse">
            H
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-slate-800">"H" Tala med handboken</h1>
            <p className="text-[10px] text-slate-400 font-medium">Röststyrd Diskussionsledare</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Status badge */}
          <div className={cn(
            "flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all",
            isSpeaking ? "bg-blue-50 text-blue-700 border border-blue-100" :
            liveConnected ? "bg-emerald-50 text-emerald-700 border border-emerald-100 animate-pulse" :
            "bg-slate-50 text-slate-500 border border-slate-100"
          )}>
            <div className={cn(
              "w-1.5 h-1.5 rounded-full",
              isSpeaking ? "bg-blue-500 animate-ping" :
              liveConnected ? "bg-emerald-500" :
              "bg-slate-300"
            )}></div>
            <span>
              {isSpeaking ? "Talar" :
               liveConnected ? "Lyssnar" :
               "Vilande"}
            </span>
          </div>

          {/* Minimalist Gear Icon for configuration */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            title="Inställningar"
            id="settings-toggle-btn"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* Main Single Card Content Centered */}
      <main className="flex-1 flex items-center justify-center p-4 overflow-hidden relative">
        <div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-xl flex flex-col overflow-hidden max-h-[85vh]">
          
          {/* Visual Step Progress Header */}
          <div className="bg-slate-50/80 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              {guideStep === 0 ? "Välkommen" : `Steg ${guideStep} av 4`}
            </span>
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map((step) => (
                <div
                  key={step}
                  className={cn(
                    "w-2.5 h-2.5 rounded-full transition-all duration-350",
                    guideStep === step ? "bg-blue-600 scale-125 shadow-sm" :
                    guideStep > step ? "bg-blue-300" : "bg-slate-200"
                  )}
                />
              ))}
            </div>
          </div>

          {/* Discussion Leader Scrollable Log */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-[180px] bg-gradient-to-b from-white to-slate-50/50">
            <AnimatePresence initial={false}>
              {chatLog.map((msg, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex flex-col max-w-[85%] rounded-2xl p-3 text-sm shadow-sm",
                    msg.sender === "leader"
                      ? "bg-white border border-slate-100 text-slate-800 mr-auto rounded-tl-none"
                      : "bg-blue-600 text-white ml-auto rounded-tr-none"
                  )}
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                  <span className="text-[9px] mt-1.5 opacity-60 self-end">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            <div ref={chatEndRef} />
          </div>

          {/* Dynamic Interactive Panel: Shows strictly ONE relevant thing at a time */}
          <div className="p-4 border-t border-slate-150 bg-white flex flex-col gap-3 shrink-0">
            
            {/* Copied visual feedback overlay */}
            <AnimatePresence>
              {copied && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="bg-emerald-50 border border-emerald-100 text-emerald-800 text-[11px] p-2 rounded-lg flex items-center justify-center gap-2"
                >
                  <CheckCircle2 size={14} className="text-emerald-500 animate-bounce" />
                  <span>Källor har kopierats automatiskt till ditt urklipp!</span>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              
              {/* Step 0: Invitation */}
              {guideStep === 0 && (
                <motion.div
                  key="step-0"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col items-center py-4 w-full"
                >
                  {!liveConnected ? (
                    <button
                      type="button"
                      onClick={() => {
                        startLiveSession();
                      }}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 px-6 rounded-2xl shadow-xl transition-all text-xs tracking-wide animate-pulse flex items-center justify-center gap-2 active:scale-95 uppercase"
                      id="welcome-start-btn"
                    >
                      <Sparkles size={16} />
                      <span>JA, TALA MED HANDBOKEN (STARTA RÖSTSAMTAL)</span>
                    </button>
                  ) : (
                    <div className="w-full space-y-4 text-center">
                      <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-2xl text-emerald-800 text-xs font-medium space-y-2">
                        <p className="font-bold text-sm text-emerald-950">🎙️ Röstsamtal är nu igång!</p>
                        <p className="text-slate-600">Du talar live med diskussionsledaren. Säg hej eller klicka på knappen nedan för att gå till nästa steg.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setGuideStep(1);
                          const txt = "Härligt! Låt oss hämta länkarna till handboken. Klicka på 'HÄMTA LÄNKAR' på skärmen så hämtar jag dem och kopierar automatiskt alla 44 källor till ditt urklipp.";
                          setChatLog(prev => [...prev, { sender: "leader", text: txt, timestamp: new Date() }]);
                          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                            wsRef.current.send(JSON.stringify({ text: `Användaren klickade för att gå vidare till steg 1. Vänligen säg detta nu: ${txt}` }));
                          }
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-6 rounded-2xl shadow-md text-xs tracking-wider uppercase flex items-center justify-center gap-2 active:scale-95"
                      >
                        <span>GÅ TILL HÄMTA LÄNKAR ➔</span>
                      </button>
                    </div>
                  )}
                </motion.div>
              )}

              {/* Step 1: Scan URLs */}
              {guideStep === 1 && (
                <motion.div
                  key="step-1"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col gap-2"
                >
                  <button
                    type="button"
                    disabled={scanLoading}
                    onClick={handleScan}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-6 rounded-xl shadow-md transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-85"
                    id="fetch-links-btn"
                  >
                    {scanLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span>HÄMTAR KÄLLOR FRÅN HANDBOKEN...</span>
                      </div>
                    ) : (
                      <>
                        <Search size={16} />
                        <span>1. HÄMTA LÄNKAR</span>
                      </>
                    )}
                  </button>
                  <p className="text-[10px] text-slate-400 text-center italic mt-1">
                    Hämtar de officiella instruktionerna och sparar alla 44 källor i ditt urklipp
                  </p>
                </motion.div>
              )}

              {/* Step 2: Open NotebookLM */}
              {guideStep === 2 && (
                <motion.div
                  key="step-2"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col gap-2.5"
                >
                  <a
                    href="https://notebooklm.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full bg-[#1a73e8] hover:bg-[#1557b0] text-white text-xs font-bold py-3.5 px-4 rounded-xl shadow-md text-center flex items-center justify-center gap-2"
                    id="open-notebook-btn"
                  >
                    <ExternalLink size={14} />
                    <span>2. ÖPPNA NOTEBOOKLM</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => {
                      setGuideStep(3);
                      const txt = "Snyggt jobbat! Nu är din handbok laddad i din Notebook. Prova gärna att chatta i fältet nere till höger, till exempel 'Vad säger handboken om stöd till familjer?'. Svara mig när du vill gå vidare!";
                      setChatLog(prev => [...prev, { sender: "leader", text: txt, timestamp: new Date() }]);
                      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ text: `Användaren klickade på Jag har klistrat in länkarna. Vänligen säg detta nu: ${txt}` }));
                      } else {
                        startLiveSession(txt);
                      }
                    }}
                    className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-3 px-4 rounded-xl text-xs transition-all flex items-center justify-center gap-2"
                    id="next-step-2-btn"
                  >
                    <span>JAG HAR KLISTRAT IN LÄNKARNA</span>
                    <ChevronRight size={14} />
                  </button>
                </motion.div>
              )}

              {/* Step 3: Test chatting */}
              {guideStep === 3 && (
                <motion.div
                  key="step-3"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col gap-2"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setGuideStep(4);
                      const txt = "Fantastiskt! Nu ska vi koppla ihop handboken med Gemini. Innan du trycker på mikrofonen i Gemini, klicka på plustecknet till vänster om chattrutan, välj 'Fler uppladdningar' och klicka på 'Notebooks'. Välj den översta anteckningsboken i listan och klicka på 'infoga'. Nu kan du prata direkt med handboken! För bästa och mest detaljerade svar, använd mikrofonsymbolen för att turas om att prata, eller skriv i chatten. Om du vill ha en mer naturlig och snabb dialog, klicka på Live-symbolen för en röstchatt – men tänk på att svaren då blir lite mindre detaljerade!";
                      setChatLog(prev => [...prev, { sender: "leader", text: txt, timestamp: new Date() }]);
                      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ text: `Användaren klickade på Jag har testat att chatta. Vänligen säg detta nu: ${txt}` }));
                      } else {
                        startLiveSession(txt);
                      }
                    }}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 px-6 rounded-xl shadow-md text-xs flex items-center justify-center gap-1.5"
                    id="next-step-3-btn"
                  >
                    <span>3. JAG HAR TESTAT ATT CHATTA (GÅ VIDARE)</span>
                    <ChevronRight size={14} />
                  </button>
                  <p className="text-[10px] text-slate-400 text-center italic mt-1">
                    Säg "Jag har testat" eller klicka på knappen för att starta röstsamtalet
                  </p>
                </motion.div>
              )}

              {/* Step 4: Open Gemini Live */}
              {guideStep === 4 && (
                <motion.div
                  key="step-4"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col gap-3"
                >
                  <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-3.5 text-slate-700 text-xs space-y-2 leading-relaxed">
                    <p className="font-bold text-blue-800">Följ dessa exakta instruktioner i Gemini:</p>
                    <ol className="list-decimal list-inside space-y-1 text-slate-600 pl-1">
                      <li>Öppna Gemini genom knappen nedan.</li>
                      <li>Klicka på <strong className="text-slate-800 font-bold">+ knappen</strong> till vänster om chattrutan.</li>
                      <li>Välj menyvalet <strong className="text-slate-800 font-bold">"Fler uppladdningar"</strong> och sedan <strong className="text-slate-800 font-bold">"Notebooks"</strong>.</li>
                      <li>Välj den <strong className="text-slate-800 font-bold">översta anteckningsboken</strong> i listan och klicka på <strong className="text-slate-800 font-bold">"infoga"</strong>.</li>
                    </ol>
                    <p className="text-[11px] pt-1 border-t border-blue-100/60 mt-2 text-slate-500">
                      🎤 <strong>Turas om att prata:</strong> Klicka på mikrofonsymbolen i Gemini för mest detaljerade svar.
                    </p>
                    <p className="text-[11px] text-slate-500">
                      ⚡ <strong>Live röstchatt:</strong> Klicka på Live-symbolen för naturlig dialog men mindre detaljerade svar.
                    </p>
                  </div>

                  <a
                    href="https://gemini.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-bold py-3.5 px-4 rounded-xl shadow-lg text-center flex items-center justify-center gap-2"
                    id="open-gemini-btn"
                  >
                    <Bot size={14} />
                    <span>4. ÖPPNA GEMINI</span>
                  </a>

                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-full border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-bold py-2 px-4 rounded-xl transition-colors flex items-center justify-center gap-1.5"
                    id="restart-guidance-btn"
                  >
                    <RotateCcw size={12} />
                    <span>BÖRJA OM FRÅN BÖRJAN</span>
                  </button>
                </motion.div>
              )}

            </AnimatePresence>

            {/* Custom Reply & Voice Controls */}
            <div className="pt-2 border-t border-slate-100 flex flex-col gap-2.5">
              
              {/* Dynamic Interactive voice animation waves */}
              <div className="flex items-center justify-center h-8 relative">
                {isSpeaking ? (
                  <div className="flex items-center gap-1">
                    {[...Array(6)].map((_, i) => (
                      <motion.div
                        key={i}
                        className="w-1 bg-blue-500 rounded-full"
                        animate={{ height: [8, 24, 8] }}
                        transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" }}
                      />
                    ))}
                    <span className="text-[9px] text-blue-500 font-bold tracking-widest ml-1 uppercase">H talar...</span>
                  </div>
                ) : liveConnected ? (
                  isMuted ? (
                    <div className="flex items-center gap-1.5 animate-pulse">
                      <span className="text-[10px] text-amber-500 font-bold uppercase tracking-wide">⏸️ Röstsamtalet är pausat</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      {[...Array(6)].map((_, i) => (
                        <motion.div
                          key={i}
                          className="w-1 bg-emerald-500 rounded-full"
                          animate={{ height: [6, 18, 6] }}
                          transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.08, ease: "easeInOut" }}
                        />
                      ))}
                      <span className="text-[9px] text-emerald-500 font-bold tracking-widest ml-1 uppercase animate-pulse">Lyssnar på dig...</span>
                    </div>
                  )
                ) : (
                  <span className="text-[9px] text-slate-300 font-bold tracking-widest uppercase">🎙️ Klicka ovan för att starta röstsamtal med handboken</span>
                )}
              </div>

              {/* Robust control buttons */}
              <div className="flex items-center gap-2.5 bg-slate-50 p-2 rounded-xl">
                {liveConnected ? (
                  <>
                    {/* Pausa / Spela Mute Toggle */}
                    <button
                      type="button"
                      onClick={toggleMute}
                      className={cn(
                        "flex-1 py-3 px-4 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-sm uppercase tracking-wider",
                        isMuted 
                          ? "bg-amber-500 hover:bg-amber-600 text-white" 
                          : "bg-white border border-slate-200 hover:bg-slate-100 text-slate-700"
                      )}
                      id="pause-toggle-btn"
                    >
                      {isMuted ? (
                        <>
                          <Play size={13} />
                          <span>Återuppta</span>
                        </>
                      ) : (
                        <>
                          <Pause size={13} />
                          <span>Pausa röst</span>
                        </>
                      )}
                    </button>

                    {/* End Call Button */}
                    <button
                      type="button"
                      onClick={stopLiveSession}
                      className="px-4 py-3 bg-rose-50 hover:bg-rose-100 border border-rose-150 text-rose-700 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 uppercase tracking-wider"
                      id="stop-call-btn"
                    >
                      <MicOff size={13} />
                      <span>Avsluta</span>
                    </button>

                    {/* Nollställ Button */}
                    <button
                      type="button"
                      onClick={handleStop}
                      className="px-4 py-3 bg-white border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 uppercase tracking-wider"
                      id="stop-reset-btn"
                    >
                      <RotateCcw size={13} />
                      <span>Nollställ</span>
                    </button>
                  </>
                ) : (
                  /* If not connected, only show start button if we are beyond step 0 */
                  guideStep > 0 ? (
                    <button
                      type="button"
                      onClick={() => startLiveSession()}
                      className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 shadow-sm uppercase tracking-wider"
                      id="mic-toggle-btn"
                    >
                      <Mic size={14} />
                      <span>Starta röstsamtal</span>
                    </button>
                  ) : (
                    /* On step 0, prompt the user to use the big emerald button above */
                    <div className="flex-1 py-2 text-center text-slate-400 text-[11px] italic font-medium">
                      Klicka på den stora knappen ovan för att starta röstsamtalet!
                    </div>
                  )
                )}
              </div>

              {/* Text Reply Option (Alternative to voice) */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customReply.trim()) handleUserResponse(customReply);
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={customReply}
                  onChange={(e) => setCustomReply(e.target.value)}
                  placeholder="Skriv svar eller klicka på knapparna..."
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <button
                  type="submit"
                  disabled={!customReply.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-2 rounded-xl disabled:opacity-50 transition-colors"
                >
                  Svara
                </button>
              </form>

            </div>
          </div>
        </div>
      </main>

      {/* Settings Modal (Toggled by Gear Icon) */}
      <AnimatePresence>
        {settingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              {/* Header */}
              <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <div className="flex items-center gap-2 text-slate-800">
                  <Settings size={18} className="text-slate-500 animate-spin-slow" />
                  <span className="font-bold text-sm">Inställningar & Granskning</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Content */}
              <div className="p-5 space-y-4 overflow-y-auto">
                
                {/* Handbook URL Input */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                    Handbokens URL-adress
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                    placeholder="https://..."
                  />
                  <p className="text-[10px] text-slate-400">
                    Standardadressen pekar på handboken för Jesu Kristi Kyrka av Sista Dagars heliga på engelska.
                  </p>
                </div>

                {/* API Key Input */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                    Gemini API-nyckel (frivillig)
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      const val = e.target.value;
                      setApiKey(val);
                      localStorage.setItem("gemini_api_key", val);
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                    placeholder="Klistra in din Gemini API-nyckel..."
                  />
                  <p className="text-[10px] text-slate-400 leading-normal">
                    Frivilligt lokalt tillägg för röstigenkänning och avancerad filtrering. Din nyckel sparas säkert enbart lokalt i din webbläsare.
                  </p>
                </div>

                {/* Collapsible raw links preview (Hides clutter by default) */}
                <div className="pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowSources(!showSources)}
                    className="w-full flex justify-between items-center py-2 text-xs font-bold text-slate-600 hover:text-slate-800"
                    id="show-sources-toggle-btn"
                  >
                    <span>Granska funna källor ({rawLinks.length})</span>
                    <ChevronRight size={14} className={cn("transition-transform", showSources && "rotate-90")} />
                  </button>

                  <AnimatePresence>
                    {showSources && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden bg-slate-50 rounded-xl mt-1.5 max-h-[220px] overflow-y-auto border border-slate-200"
                      >
                        {rawLinks.length === 0 ? (
                          <div className="p-4 text-center text-slate-400 text-xs">
                            Kör Steg 1 "Hämta Länkar" på skärmen för att se källorna.
                          </div>
                        ) : (
                          <div className="p-2 space-y-1.5 divide-y divide-slate-200 text-[11px]">
                            {rawLinks.map((item, idx) => (
                              <div key={idx} className="pt-1.5 first:pt-0">
                                <p className="font-bold text-slate-700 truncate">{item.text || "Handbokskälla"}</p>
                                <p className="text-slate-400 font-mono text-[9px] truncate selection:bg-slate-200">{item.url}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Footer */}
              <div className="p-4 bg-slate-50 border-t border-slate-150 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setUrl(defaultUrl);
                    setApiKey("");
                    localStorage.removeItem("gemini_api_key");
                  }}
                  className="text-slate-500 hover:text-slate-700 text-xs font-bold px-3 py-2 transition-colors uppercase tracking-wider"
                  id="reset-settings-btn"
                >
                  Nollställ all data
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold px-4 py-2 rounded-xl shadow-sm transition-colors uppercase tracking-wider"
                  id="close-settings-btn"
                >
                  Stäng
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      
    </div>
  );
}
