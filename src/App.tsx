import React, { useState, useMemo, useRef, useEffect } from "react";
import { Copy, Dna, Search, Link as LinkIcon, CheckCircle2, FileText, ChevronDown, ChevronRight, Download, Bot, Filter, Layers, Volume2, VolumeX, ArrowRight, Sparkles, Mic, MicOff, MessageSquare, ExternalLink, Key, Settings, User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";

interface BasicLink {
  url: string;
  text: string;
}

interface LinkItem extends BasicLink {
  isIdealForNotebookLM: boolean;
}

interface Category {
  name: string;
  description?: string;
  links: LinkItem[];
}

const defaultUrl = "https://www.churchofjesuschrist.org/study/manual/general-handbook?lang=eng";

export default function App() {
  const [url, setUrl] = useState(defaultUrl);
  
  // Scanning state
  const [scanLoading, setScanLoading] = useState(false);
  const [rawLinks, setRawLinks] = useState<BasicLink[]>([]);
  const [scanned, setScanned] = useState(false);
  
  // Audio / Discussion Leader State
  const [guideStep, setGuideStep] = useState(0); // 0 = Inte startat, 1-4 = Steg
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [customReply, setCustomReply] = useState("");
  const [chatLog, setChatLog] = useState<{ sender: "leader" | "user"; text: string; timestamp: Date }[]>([]);

  
  // Analysis state
  const [aiLoading, setAiLoading] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  
  // UI state
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Filters
  const [filterText, setFilterText] = useState("");
  const [filterDomain, setFilterDomain] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  // New configurations
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [onlyNotebookLM, setOnlyNotebookLM] = useState(true);
  const [aiSearchQuery, setAiSearchQuery] = useState("");
  const [aiFiltering, setAiFiltering] = useState(false);
  const [aiFilteredUrls, setAiFilteredUrls] = useState<Set<string> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportDrawerOpen, setExportDrawerOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll to bottom of chat log
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatLog]);

  // Speech-to-Text Voice input method
  const startVoiceListening = () => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      setError("Röstigenkänning stöds tyvärr inte i din webbläsare. Använd gärna Google Chrome för bäst resultat.");
      return;
    }

    // Cancel active speech so it doesn't listen to itself
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }

    try {
      const SpeechObj = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognition = new SpeechObj();
      recognition.lang = "sv-SE";
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error", event);
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          handleUserResponse(transcript);
        }
      };

      recognition.start();
    } catch (e) {
      console.error(e);
      setIsListening(false);
    }
  };

  // Discussion leader voice assistant helper
  const speakStep = (stepNum: number, overrideText?: string) => {
    if (!('speechSynthesis' in window)) return;
    
    // Cancel active speech
    window.speechSynthesis.cancel();
    
    const textToSpeak = overrideText || (
      stepNum === 1 ? "Välkommen! Jag har samlat in och automatiskt kopierat alla rekommenderade källor till ditt urklipp. Klicka på knappen 'Öppna NotebookLM' för att öppna verktyget. Väl där inne, klicka på 'Skapa ny notebook' eller plustecknet." :
      stepNum === 2 ? "Perfekt! Välj nu fliken 'Webbplats' i NotebookLM. Klistra sedan in länkarna från ditt urklipp genom att trycka på Ctrl+V eller Cmd+V och klicka på 'Infoga'. Svara mig här i chatten när du är klar så fortsätter vi!" :
      stepNum === 3 ? "Härligt! Nu är din handbok laddad i din Notebook. Nu kan du ställa frågor i chatten nere till höger, till exempel 'Vad säger handboken om stöd till familjer?'. Prova att chatta en stund och svara mig sedan när du vill gå vidare!" :
      stepNum === 4 ? "Slutligen, låt oss prata med handboken med röst! Klicka på knappen 'Öppna Gemini' för att gå till gemini.google.com. Där kan du trycka på mikrofonsymbolen för att börja prata med handboken på svenska. Använd mikrofonsymbolen för bäst resultat!" : ""
    );
    
    if (!textToSpeak) return;

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = "sv-SE";
    
    const voices = window.speechSynthesis.getVoices();
    const svVoice = voices.find(v => v.lang.toLowerCase().startsWith("sv"));
    if (svVoice) {
      utterance.voice = svVoice;
    }
    
    setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    window.speechSynthesis.speak(utterance);
  };

  const handleUserResponse = (text: string) => {
    if (!text.trim()) return;
    
    const newUserMsg = { sender: "user" as const, text, timestamp: new Date() };
    setChatLog(prev => [...prev, newUserMsg]);
    
    let leaderText = "";
    const lowerText = text.toLowerCase().trim();

    // 1. Detect pasted Gemini API Key
    const apiKeyMatch = text.match(/(AIzaSy[A-Za-z0-9_-]{35})/);
    if (apiKeyMatch) {
      const extractedKey = apiKeyMatch[1];
      setApiKey(extractedKey);
      localStorage.setItem("gemini_api_key", extractedKey);
      leaderText = "Tack! Jag har lagt till din Gemini API-nyckel och sparat den säkert lokalt i din webbläsare. Nu kan vi använda avancerad AI-sökning och Gemini Live-röstfiltrering direkt i appen!";
      setTimeout(() => {
        setChatLog(prev => [...prev, { sender: "leader", text: leaderText, timestamp: new Date() }]);
        speakStep(guideStep, leaderText);
      }, 600);
      setCustomReply("");
      return;
    }

    // 2. Local filter / voice command parsing
    let isFilterCommand = false;
    if (lowerText.includes("ta bort") || lowerText.includes("exkludera") || lowerText.includes("filtrera bort") || lowerText.includes("göm") || lowerText.includes("dölj")) {
      isFilterCommand = true;
      const cleanTerm = lowerText
        .replace("ta bort", "")
        .replace("filtrera bort", "")
        .replace("exkludera", "")
        .replace("göm", "")
        .replace("dölj", "")
        .replace("länk", "")
        .replace("länkar", "")
        .replace("med", "")
        .trim();

      if (cleanTerm) {
        setFilterText(`-${cleanTerm}`);
        leaderText = `Självklart! Jag har filtrerat bort källor som innehåller "${cleanTerm}". Listan har uppdaterats och kopierats till ditt urklipp!`;
      } else {
        leaderText = "Vad vill du ta bort? Säg till exempel: 'ta bort lathund' eller 'göm externa'.";
      }
    } else if (lowerText.includes("visa alla") || lowerText.includes("återställ") || lowerText.includes("nollställ") || lowerText.includes("ta bort filter")) {
      isFilterCommand = true;
      setFilterText("");
      setAiFilteredUrls(null);
      leaderText = "Jag har återställt alla filter. Nu ser du hela länklistan igen!";
    } else if (lowerText.includes("visa bara") || lowerText.includes("behåll") || lowerText.includes("inkludera bara") || lowerText.includes("hitta")) {
      isFilterCommand = true;
      const cleanTerm = lowerText
        .replace("visa bara", "")
        .replace("behåll", "")
        .replace("inkludera bara", "")
        .replace("hitta", "")
        .trim();

      if (cleanTerm) {
        setFilterText(cleanTerm);
        leaderText = `Fixat! Jag visar nu endast källor som innehåller "${cleanTerm}". Länkarna har uppdaterats automatiskt.`;
      } else {
        leaderText = "Vad vill du visa? Säg till exempel: 'visa bara kapitel 5'.";
      }
    } else if (lowerText.includes("nyckel") || lowerText.includes("api") || lowerText.includes("studio") || lowerText.includes("hur hämtar")) {
      leaderText = "För att hämta din kostnadsfria Gemini API-nyckel:\n1. Gå till https://aistudio.google.com/\n2. Klicka på 'Get API key' längst upp till vänster.\n3. Skapa en nyckel och kopiera den.\n4. Klistra in den direkt här i vår chat så sparar jag den åt dig direkt!";
    }

    // Standard steps progress if not a filter/api instruction
    if (!leaderText) {
      const nextStep = guideStep + 1 > 4 ? 4 : guideStep + 1;
      setGuideStep(nextStep);
      
      if (nextStep === 2) {
        leaderText = "Härligt att du har skapat notebooken! Välj nu fliken 'Webbplats' (Website). Klistra sedan in länkarna från ditt urklipp (Ctrl+V eller Cmd+V) och klicka på 'Infoga' (Insert). Säg till mig när du är klar!";
      } else if (nextStep === 3) {
        leaderText = "Snyggt jobbat! Nu är din handbok laddad i din Notebook. Prova gärna att chatta i fältet nere till höger, till exempel 'Vad säger handboken om stöd till familjer?'. Berätta hur det går!";
      } else if (nextStep === 4) {
        leaderText = "Toppen! Nu öppnar vi Gemini (gemini.google.com) så att du kan börja prata med handboken med Gemini Live på svenska. Tryck på mikrofonsymbolen längst ner till höger i Gemini för att prata direkt med röst (mikrofonen ger bäst resultat).";
      } else {
        leaderText = "Jag är här för att leda dig! Säg till om du vill att jag återställer guiden eller filterinställningarna.";
      }
    }
    
    setTimeout(() => {
      setChatLog(prev => [...prev, { sender: "leader", text: leaderText, timestamp: new Date() }]);
      speakStep(guideStep, leaderText);
    }, 600);
    
    setCustomReply("");
  };

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const scanUrl = url.trim() || defaultUrl;
    
    setScanLoading(true);
    setError("");
    setCategories(null);
    setRawLinks([]);
    setScanned(false);
    setFilterDomain("");
    setFilterCategory("");
    setAiFilteredUrls(null);
    
    let links: BasicLink[] = [];
    
    try {
      // First attempt: try local Express proxy backend
      const response = await fetch("/api/extract-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scanUrl }),
      });
      
      if (response.ok) {
        const data = await response.json();
        links = data.links || [];
      } else {
        throw new Error("Local backend not available");
      }
    } catch (err: any) {
      // Second attempt: Fallback to client-side fetching via CORS proxy for Netlify deployment
      console.log("Local backend failed/unavailable, trying client-side CORS proxy...", err);
      try {
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(scanUrl)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) {
          throw new Error("CORS-proxy misslyckades.");
        }
        const html = await response.text();
        
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
            urlObj.hash = ""; // Strip fragment/hash
            const absoluteUrl = urlObj.href;
            const text = a.textContent?.trim() || "";
            
            if (!seen.has(absoluteUrl) && (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://"))) {
              seen.add(absoluteUrl);
              extracted.push({ url: absoluteUrl, text: text || "Ingen länktext" });
            }
          } catch (e) {}
        });
        links = extracted;
      } catch (proxyErr: any) {
        setError(`Misslyckades att hämta länkarna. Se till att länken är korrekt och att du är ansluten till internet. Detaljer: ${proxyErr.message}`);
        setScanLoading(false);
        return;
      }
    }

    if (links.length > 0) {
      setRawLinks(links);
      setScanned(true);
      handleManualCategorize(links);

      // Attempt automatic copying of NotebookLM links to the clipboard
      try {
        const baseDomain = new URL(scanUrl).hostname;
        const processed = links.map(link => {
          const lowerUrl = link.url.toLowerCase();
          const lowerText = link.text.toLowerCase();
          const isIdeal = 
            lowerUrl.includes('doc') || lowerUrl.includes('api') || lowerUrl.includes('guide') ||
            lowerUrl.includes('tutorial') || lowerUrl.includes('article') || lowerUrl.includes('blog') ||
            lowerText.includes('doc') || lowerText.includes('api') || lowerText.includes('guide') ||
            lowerText.includes('tutorial') || lowerText.includes('manual');
          return { ...link, isIdealForNotebookLM: isIdeal };
        });
        
        const autoLinks = onlyNotebookLM 
          ? processed.filter(l => l.isIdealForNotebookLM).map(l => l.url)
          : processed.map(l => l.url);
          
        if (autoLinks.length > 0) {
          await navigator.clipboard.writeText(autoLinks.join("\n"));
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      } catch (copyErr) {
        console.warn("Auto clipboard copy failed, likely due to iframe permissions", copyErr);
      }

      // Start Step 1 of Discussion Leader Guidance
      setGuideStep(1);
      const welcomeText = "Välkommen! Jag har samlat in och automatiskt kopierat alla rekommenderade källor till ditt urklipp. Klicka på knappen 'Öppna NotebookLM' för att öppna verktyget. Väl där inne, klicka på 'Skapa ny notebook' eller plustecknet.";
      setChatLog([
        { sender: "leader", text: welcomeText, timestamp: new Date() }
      ]);
      speakStep(1, welcomeText);
    } else {
      setError("Inga länkar hittades på den angivna sidan.");
    }
    setScanLoading(false);
  };

  const handleManualCategorize = (linksToGroup?: BasicLink[]) => {
    const targetLinks = linksToGroup || filteredRawLinks;
    if (targetLinks.length === 0) return;
    
    const groups: Record<string, LinkItem[]> = {};
    
    try {
      const baseDomain = new URL(url).hostname;
      
      targetLinks.forEach(link => {
        try {
          const urlObj = new URL(link.url);
          let catName = "Övrigt";
          const isExternal = urlObj.hostname !== baseDomain;
          
          if (isExternal) {
            catName = `Extern (${urlObj.hostname})`;
          } else {
            const paths = urlObj.pathname.split('/').filter(Boolean);
            if (paths.length === 0) {
              catName = "Hemsida / Rot";
            } else {
              // Capitalize first path segment
              catName = paths[0].charAt(0).toUpperCase() + paths[0].slice(1);
            }
          }
          
          if (!groups[catName]) {
            groups[catName] = [];
          }
          
          // Heuristic for NotebookLM: Check if path or text contains doc, api, guide, tutorial, article etc.
          const lowerUrl = link.url.toLowerCase();
          const lowerText = link.text.toLowerCase();
          const isIdeal = 
            lowerUrl.includes('doc') || lowerUrl.includes('api') || lowerUrl.includes('guide') ||
            lowerUrl.includes('tutorial') || lowerUrl.includes('article') || lowerUrl.includes('blog') ||
            lowerText.includes('doc') || lowerText.includes('api') || lowerText.includes('guide') ||
            lowerText.includes('tutorial') || lowerText.includes('manual');
            
          groups[catName].push({
            ...link,
            isIdealForNotebookLM: isIdeal
          });
        } catch (e) {
          if (!groups["Okänd"]) groups["Okänd"] = [];
          groups["Okänd"].push({ ...link, isIdealForNotebookLM: false });
        }
      });
      
      const newItems = Object.keys(groups).map(name => ({
        name,
        links: groups[name]
      })).sort((a, b) => b.links.length - a.links.length);

      setCategories(newItems);
      
      const expanded: Record<string, boolean> = {};
      newItems.forEach(c => expanded[c.name] = true);
      setExpandedCategories(expanded);
      
    } catch (e) {
      console.error("Pattern categorization failed", e);
      setError("Kunde inte analysera domänen.");
    }
  };

  const handleAnalyze = async () => {
    if (filteredRawLinks.length === 0) return;
    
    setAiLoading(true);
    setError("");
    
    try {
      const response = await fetch("/api/analyze-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, links: filteredRawLinks }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Ett okänt fel uppstod vid AI-analys.");
      }
      
      setCategories(data.categories || []);
      // Auto-expand all categories
      if (data.categories) {
        const expanded: Record<string, boolean> = {};
        data.categories.forEach((c: Category) => {
          expanded[c.name] = true;
        });
        setExpandedCategories(expanded);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiSearch = async () => {
    if (!aiSearchQuery.trim()) {
      setAiFilteredUrls(null);
      return;
    }
    
    if (!apiKey) {
      setError("Fyll i din Gemini API-nyckel under 'Avancerat' för att kunna filtrera med AI på statiska miljöer som Netlify.");
      return;
    }

    setAiFiltering(true);
    setError("");
    
    try {
      const allUrls = rawLinks.map(l => ({ url: l.url, text: l.text }));
      const prompt = `Du är en expert på att filtrera länkar. Användaren vill filtrera en lista med länkar för att endast behålla de som är relevanta för följande sökning/ämne: "${aiSearchQuery}"

Här är länkarna ($URL och tillhörande text):
${allUrls.slice(0, 300).map(l => `- URL: ${l.url} | Text: ${l.text}`).join("\n")}

Din uppgift är att analysera länkarna och avgöra vilka som är relevanta för ämnet. Returnera endast de matchande URL:erna i JSON-format med fältet "matchingUrls". Om inga länkar matchar, returnera en tom lista.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                matchingUrls: {
                  type: "ARRAY",
                  items: { type: "STRING" }
                }
              },
              required: ["matchingUrls"]
            }
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData?.error?.message || "Kunde inte ansluta till Gemini API.");
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Fick inget svar från Gemini.");

      const result = JSON.parse(text);
      const urls = result.matchingUrls || [];
      setAiFilteredUrls(new Set(urls));
    } catch (err: any) {
      setError(`AI-sökning misslyckades: ${err.message}`);
    } finally {
      setAiFiltering(false);
    }
  };

  const handleResetAiSearch = () => {
    setAiSearchQuery("");
    setAiFilteredUrls(null);
  };

  // Extract unique domains for filter dropdown
  const uniqueDomains = useMemo(() => {
    const urls = categories 
      ? categories.flatMap(c => c.links.map(l => l.url))
      : rawLinks.map(l => l.url);
      
    const domains = new Set<string>();
    urls.forEach(u => {
      try {
        domains.add(new URL(u).hostname);
      } catch (e) {}
    });
    return Array.from(domains).sort();
  }, [rawLinks, categories]);

  // Extract category names for filter dropdown
  const availableCategories = useMemo(() => {
    return categories ? categories.map(c => c.name).sort() : [];
  }, [categories]);

  // Filtering logic
  const passesTextAndDomain = (link: BasicLink) => {
    const matchesText = !filterText || 
      link.text.toLowerCase().includes(filterText.toLowerCase()) || 
      link.url.toLowerCase().includes(filterText.toLowerCase());
      
    let matchesDomain = true;
    if (filterDomain) {
      try {
        matchesDomain = new URL(link.url).hostname === filterDomain;
      } catch (e) {
        matchesDomain = false;
      }
    }
    
    const matchesAiFilter = !aiFilteredUrls || aiFilteredUrls.has(link.url);
    
    return matchesText && matchesDomain && matchesAiFilter;
  };

  const filteredRawLinks = useMemo(() => {
    return rawLinks.filter(passesTextAndDomain);
  }, [rawLinks, filterText, filterDomain, aiFilteredUrls]);

  const filteredCategories = useMemo(() => {
    if (!categories) return null;
    return categories
      .filter(c => !filterCategory || c.name === filterCategory)
      .map(c => ({
        ...c,
        links: c.links.filter(passesTextAndDomain)
      }))
      .filter(c => c.links.length > 0); // Hide empty categories
  }, [categories, filterText, filterDomain, filterCategory, aiFilteredUrls]);

  const getNotebookLMLinks = () => {
    if (!filteredCategories) return [];
    const allLinks = filteredCategories.flatMap((c) => c.links);
    
    if (onlyNotebookLM) {
      return allLinks.filter((l) => l.isIdealForNotebookLM).map((l) => l.url);
    }
    return allLinks.map((l) => l.url);
  };

  const notebookLmLinks = getNotebookLMLinks();
  const totalLinks = categories 
    ? (filteredCategories?.reduce((sum, c) => sum + c.links.length, 0) || 0)
    : filteredRawLinks.length;

  const handleCopy = async () => {
    const urls = notebookLmLinks.join("\n");
    if (!urls) return;
    
    try {
      await navigator.clipboard.writeText(urls);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy!", err);
    }
  };

  const toggleCategory = (name: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [name]: !prev[name]
    }));
  };

  return (
    <div className="h-screen w-full bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white shadow-sm font-bold text-xs tracking-tighter">
            LS
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-800">NotebookLM Länksamlare</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-green-50 text-green-700 px-2 py-1 rounded border border-green-100">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-[10px] font-bold uppercase tracking-wider">Redo</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col p-6 gap-6 overflow-hidden max-w-7xl mx-auto w-full">
        {/* Search Hero */}
        <section className="flex flex-col gap-4 shrink-0 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
             <h2 className="text-lg font-bold tracking-tight text-slate-800 flex items-center gap-2">
              <Search size={18} className="text-blue-600" /> 
              Analysera URL
             </h2>
          </div>

          <form onSubmit={handleScan} className="w-full flex flex-col md:flex-row gap-4 relative group">
            <div className="relative flex-1">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://exempel.se/dokumentation"
                required
                className="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 shadow-inner"
              />
            </div>
            <button
              type="submit"
              disabled={scanLoading || aiLoading}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-6 py-2 rounded shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {scanLoading ? (
                <>
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
                    <Search size={14} />
                  </motion.div>
                  <span>HÄMTAR...</span>
                </>
              ) : (
                <span>1. HÄMTA LÄNKAR</span>
              )}
            </button>
          </form>

          {/* Quick open and autogrouping helper buttons */}
          {scanned && (
            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              <a
                href="https://notebooklm.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[#1a73e8] hover:bg-[#1557b0] text-white text-xs font-bold py-2.5 px-6 rounded-lg shadow-sm transition-all active:scale-[0.99] flex items-center justify-center gap-2 flex-1 text-center"
              >
                <ExternalLink size={14} />
                <span>2. ÖPPNA NOTEBOOKLM</span>
              </a>
              {rawLinks.length > 0 && !categories && (
                <button
                  type="button"
                  onClick={() => handleAnalyze()}
                  disabled={aiLoading}
                  className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold py-2.5 px-6 rounded-lg shadow-sm transition-all active:scale-[0.99] flex items-center justify-center gap-2"
                >
                  <Bot size={14} />
                  <span>KÖR AUTOGRUPPERING (REKOMMENDERAS)</span>
                </button>
              )}
            </div>
          )}

          {/* Collapsible Custom Settings and Advanced Filters */}
          {scanned && (
            <div className="border border-slate-200 rounded-xl bg-slate-50/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setSettingsOpen(!settingsOpen)}
                className="w-full flex items-center justify-between p-3 text-xs font-bold text-slate-700 hover:bg-slate-100/50 transition-colors select-none"
              >
                <div className="flex items-center gap-2">
                  <Settings size={14} className="text-slate-500" />
                  <span>ANPASSA APPEN & INSTÄLLNINGAR</span>
                </div>
                <div className="flex items-center gap-2">
                  {apiKey ? (
                    <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold uppercase">AI Aktiv</span>
                  ) : (
                    <span className="text-[9px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded font-bold uppercase">Endast lokal</span>
                  )}
                  {settingsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </button>

              <AnimatePresence>
                {settingsOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-slate-200 bg-white p-4 flex flex-col gap-4 overflow-hidden"
                  >
                    {/* Manual inputs & Dropdowns */}
                    <div className="flex flex-col md:flex-row gap-3">
                      <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Filter className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <input
                          type="text"
                          value={filterText}
                          onChange={(e) => setFilterText(e.target.value)}
                          placeholder="Filtrera på nyckelord eller URL (t.ex. '-lathund' eller 'kapitel')..."
                          className="w-full bg-slate-50 border border-slate-200 rounded-md py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                        />
                      </div>
                      <select
                        value={filterDomain}
                        onChange={(e) => setFilterDomain(e.target.value)}
                        className="bg-slate-50 border border-slate-200 rounded-md py-1.5 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-full md:w-48 appearance-none"
                      >
                        <option value="">Alla domäner</option>
                        {uniqueDomains.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                      
                      {categories && (
                        <select
                          value={filterCategory}
                          onChange={(e) => setFilterCategory(e.target.value)}
                          className="bg-slate-50 border border-slate-200 rounded-md py-1.5 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-full md:w-48 appearance-none"
                        >
                          <option value="">Alla kategorier</option>
                          {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                    </div>

                    {/* AI Filter Search */}
                    <div className="flex flex-col md:flex-row gap-3 pt-3 border-t border-dashed border-slate-150">
                      <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Bot className="h-3.5 w-3.5 text-blue-500" />
                        </div>
                        <input
                          type="text"
                          value={aiSearchQuery}
                          onChange={(e) => setAiSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && aiSearchQuery.trim()) {
                              e.preventDefault();
                              handleAiSearch();
                            }
                          }}
                          placeholder="Finsök med AI (t.ex. 'Hitta endast sidor relaterade till autentisering')..."
                          className="w-full bg-blue-50/50 border border-blue-100 rounded-md py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleAiSearch}
                          disabled={aiFiltering || !aiSearchQuery.trim()}
                          className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-1.5 rounded shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 shrink-0"
                        >
                          {aiFiltering ? "SÖKER..." : "AI SÖKNING"}
                        </button>
                        {aiFilteredUrls && (
                          <button
                            type="button"
                            onClick={handleResetAiSearch}
                            className="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold px-3 py-1.5 rounded transition-colors shrink-0"
                          >
                            ÅTERSTÄLL
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Gemini API Key input */}
                    <div className="pt-3 border-t border-slate-150">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-bold text-slate-600 flex items-center gap-1">
                          <Key size={12} className="text-slate-400" />
                          <span>Din Gemini API-nyckel</span>
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => {
                              const val = e.target.value;
                              setApiKey(val);
                              localStorage.setItem("gemini_api_key", val);
                            }}
                            placeholder="Klistra in din Gemini API-nyckel här..."
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-md py-1.5 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                        </div>
                        <p className="text-[10px] text-slate-400">
                          För att använda röststyrning och Gemini Live-filtrering behöver du en kostnadsfri API-nyckel. Gå till{" "}
                          <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-bold">
                            Google AI Studio
                          </a>{" "}
                          för att hämta din nyckel helt gratis. Du kan också klistra in nyckeln direkt i chatten!
                        </p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {error && (
             <div className="mt-2 px-3 py-2 bg-red-50 border border-red-100 rounded text-red-600 text-xs flex items-center gap-2">
              ⚠️ <span>{error}</span>
            </div>
          )}
        </section>

        {/* Results Area */}
        <AnimatePresence mode="wait">
          {scanned && (
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex-1 flex gap-6 overflow-hidden"
            >
              {/* Left Column: Link List */}
              <div className="flex-[3] flex flex-col gap-4 overflow-hidden">
                <div className="flex items-center justify-between shrink-0">
                  <h2 className="font-bold text-slate-800">
                    {categories ? "Kategoriserade & Filtrerade Länkar" : "Hittade Länkar (Filtrerade)"}
                  </h2>
                  <span className="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-1 rounded font-medium">
                    {totalLinks} st totalt
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-sm hide-scrollbar">
                  {totalLinks === 0 && (
                    <div className="p-8 text-center text-slate-500 text-sm flex flex-col items-center justify-center">
                      <Search size={32} className="text-slate-300 mb-3" />
                      <p>Inga länkar matchar dina valda filter.</p>
                    </div>
                  )}

                  {/* Show raw filtered links if AI hasn't run yet */}
                  {!categories && totalLinks > 0 && (
                     <table className="w-full text-left border-collapse">
                      <tbody className="text-sm">
                        {filteredRawLinks.map((link, j) => (
                          <tr
                            key={j}
                            className="border-b border-slate-100 last:border-0 hover:bg-slate-50 group transition-colors"
                          >
                            <td className="px-4 py-3 min-w-0 max-w-[200px]">
                              <div className="flex items-center gap-2">
                                <LinkIcon size={14} className="text-slate-300 shrink-0 group-hover:text-blue-400 transition-colors" />
                                <p className="font-medium text-slate-700 truncate text-[13px]" title={link.text}>
                                  {link.text || "Länk utan text"}
                                </p>
                              </div>
                            </td>
                            <td className="px-4 py-3 min-w-0">
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[12px] text-slate-400 font-mono hover:text-blue-500 hover:underline truncate block max-w-full"
                              >
                                {link.url}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Show categorized links if AI has run */}
                  {categories && filteredCategories && filteredCategories.map((category, i) => {
                    const isExpanded = expandedCategories[category.name];
                    return (
                      <div key={i} className="border-b border-slate-200 last:border-0">
                        <button
                          onClick={() => toggleCategory(category.name)}
                          className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100/50 transition-colors text-left"
                        >
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <ChevronDown size={14} className="text-slate-400" />
                              ) : (
                                <ChevronRight size={14} className="text-slate-400" />
                              )}
                              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-widest">
                                {category.name}
                              </h4>
                              <span className="text-[10px] font-bold bg-slate-200/50 text-slate-500 px-1.5 py-0.5 rounded ml-1">
                                {category.links.length}
                              </span>
                            </div>
                          </div>
                        </button>
                        
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden bg-white"
                            >
                              <table className="w-full text-left border-collapse">
                                <tbody className="text-sm">
                                  {category.links.map((link, j) => (
                                    <tr
                                      key={j}
                                      className="border-t border-slate-100/50 hover:bg-slate-50 group transition-colors"
                                    >
                                      <td className="px-4 py-2 min-w-0 max-w-[200px]">
                                        <div className="flex items-center gap-2">
                                          <LinkIcon size={12} className="text-slate-300 shrink-0 group-hover:text-blue-400 transition-colors" />
                                          <p className="font-medium text-blue-600 truncate text-[13px]" title={link.text}>
                                            {link.text || "Länk utan text"}
                                          </p>
                                        </div>
                                      </td>
                                      <td className="px-4 py-2 w-1/3 min-w-0">
                                        <a
                                          href={link.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[11px] text-slate-400 font-mono hover:text-blue-500 hover:underline truncate block max-w-full"
                                        >
                                          {link.url}
                                        </a>
                                      </td>
                                      <td className="px-4 py-2 w-24 text-right shrink-0">
                                        {link.isIdealForNotebookLM && (
                                          <span className="bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border border-emerald-100">
                                            Källa
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Unified AI Discussion Leader with Integrated Collapsible Export */}
              <div className="flex-[2] flex flex-col bg-gradient-to-br from-blue-50 to-indigo-50/50 border border-blue-100 rounded-xl shadow-sm overflow-hidden h-full">
                
                {/* Header of AI Discussion Leader */}
                <div className="p-4 bg-white border-b border-blue-100 shrink-0 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white relative">
                      {isListening ? (
                        <Mic size={16} className="animate-pulse text-green-300" />
                      ) : (
                        <Mic size={16} />
                      )}
                      {isSpeaking && (
                        <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-75"></span>
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider">AI Diskussionsledare</h3>
                      <p className="text-[10px] text-slate-500 font-medium flex items-center gap-1">
                        <span>Röststyrd & Steg-för-steg</span>
                        {isListening && (
                          <span className="text-green-600 font-bold animate-pulse text-[9px] uppercase">(Lyssnar...)</span>
                        )}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => startVoiceListening()}
                      className={cn(
                        "p-2 rounded-full transition-all duration-200",
                        isListening 
                          ? "bg-red-500 text-white shadow-md animate-bounce" 
                          : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      )}
                      title={isListening ? "Klicka för att stänga av mikrofonen" : "Klicka för att prata med diskussionsledaren (Gemini Live)"}
                    >
                      <Mic size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => speakStep(guideStep || 1)}
                      className={cn(
                        "p-2 rounded-full transition-colors bg-slate-100 text-slate-600 hover:bg-slate-200",
                        isSpeaking && "bg-blue-100 text-blue-700"
                      )}
                      title="Spela upp röstinstruktion igen"
                    >
                      <Volume2 size={15} />
                    </button>
                  </div>
                </div>

                {/* Step Progress indicators */}
                <div className="grid grid-cols-4 gap-1.5 p-3 bg-white/50 border-b border-blue-100 shrink-0">
                  {[
                    { id: 1, label: "Skapa" },
                    { id: 2, label: "Klistra in" },
                    { id: 3, label: "Chatta" },
                    { id: 4, label: "Gemini Röst" }
                  ].map((step) => {
                    const isActive = guideStep === step.id;
                    const isCompleted = guideStep > step.id;
                    return (
                      <div key={step.id} className="flex flex-col gap-1">
                        <div
                          className={cn(
                            "h-1 rounded-full transition-all duration-300",
                            isCompleted ? "bg-emerald-500" :
                            isActive ? "bg-blue-600 w-full animate-pulse" : "bg-slate-200"
                          )}
                        />
                        <span className={cn(
                          "text-[9px] font-bold text-center truncate",
                          isActive ? "text-blue-600 font-extrabold" :
                          isCompleted ? "text-emerald-600" : "text-slate-400"
                        )}>
                          {step.id}. {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Speech Bubble / Chat Area - FLEX GROW to fill entire column */}
                <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3 min-h-0 bg-slate-50/40">
                  {chatLog.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-3">
                      <Bot size={36} className="text-slate-300 animate-bounce" />
                      <p className="text-xs leading-relaxed max-w-[240px]">
                        Klicka på <strong className="text-blue-600 font-bold">"1. HÄMTA LÄNKAR"</strong> till vänster för att starta diskussionsledaren och kopiera källorna automatiskt.
                      </p>
                    </div>
                  ) : (
                    chatLog.map((msg, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "flex flex-col max-w-[85%] rounded-xl p-3 shadow-sm",
                          msg.sender === "leader" 
                            ? "bg-white text-slate-800 self-start border border-blue-100/50 rounded-tl-none" 
                            : "bg-blue-600 text-white self-end rounded-tr-none"
                        )}
                      >
                        <span className="text-[9px] opacity-60 font-bold mb-1 uppercase tracking-wider flex items-center gap-1">
                          {msg.sender === "leader" ? (
                            <>
                              <Bot size={10} />
                              <span>Diskussionsledare</span>
                            </>
                          ) : (
                            <>
                              <User size={10} />
                              <span>Du (Röst)</span>
                            </>
                          )}
                        </span>
                        <p className="text-[12px] leading-relaxed whitespace-pre-line font-medium">{msg.text}</p>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Interactive Answers, Manual Input & Voice Assistant Bar */}
                <div className="p-4 bg-white border-t border-blue-100 shrink-0 flex flex-col gap-3">
                  {guideStep > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Föreslagna svar / Styrning:</p>
                      <div className="flex flex-col gap-1.5">
                        {guideStep === 1 && (
                          <button
                            type="button"
                            onClick={() => handleUserResponse("Jag har öppnat NotebookLM och skapat en ny notebook!")}
                            className="bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-[11px] text-slate-700 font-semibold py-2 px-3 rounded-lg transition-all text-left flex items-center justify-between group shadow-sm animate-pulse"
                          >
                            <span>1. Jag har skapat notebooken</span>
                            <ArrowRight size={12} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        )}
                        {guideStep === 2 && (
                          <button
                            type="button"
                            onClick={() => handleUserResponse("Jag har valt webbplatsfliken, klistrat in länkarna och klickat på infoga!")}
                            className="bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-[11px] text-slate-700 font-semibold py-2 px-3 rounded-lg transition-all text-left flex items-center justify-between group shadow-sm animate-pulse"
                          >
                            <span>2. Länkarna är inklistrade & infogade!</span>
                            <ArrowRight size={12} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        )}
                        {guideStep === 3 && (
                          <button
                            type="button"
                            onClick={() => handleUserResponse("Jag har testat att chatta med handboken och det fungerar utmärkt!")}
                            className="bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-[11px] text-slate-700 font-semibold py-2 px-3 rounded-lg transition-all text-left flex items-center justify-between group shadow-sm animate-pulse"
                          >
                            <span>3. Jag har testat chatta i NotebookLM</span>
                            <ArrowRight size={12} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        )}
                        {guideStep === 4 && (
                          <div className="bg-emerald-50 border border-emerald-100 text-emerald-800 text-[10.5px] font-semibold p-2.5 rounded-lg text-center flex flex-col items-center gap-1">
                            <Sparkles size={14} className="text-emerald-600 animate-pulse" />
                            <span>Guiden avslutad! Nu kan du ha fantastiska röstsamtal i Gemini.</span>
                            <button
                              type="button"
                              onClick={() => {
                                setGuideStep(1);
                                speakStep(1);
                              }}
                              className="text-[9.5px] text-blue-600 hover:underline mt-1 font-bold uppercase tracking-wider"
                            >
                              Börja om guiden
                            </button>
                          </div>
                        )}

                        {/* Custom input response box */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (customReply.trim()) handleUserResponse(customReply);
                          }}
                          className="flex gap-2 mt-1"
                        >
                          <input
                            type="text"
                            value={customReply}
                            onChange={(e) => setCustomReply(e.target.value)}
                            placeholder={isListening ? "Lyssnar på din röst..." : "Svara med text eller klicka på micken..."}
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                          <button
                            type="button"
                            onClick={() => startVoiceListening()}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs transition-colors border flex items-center justify-center",
                              isListening 
                                ? "bg-red-500 text-white border-red-500 animate-pulse" 
                                : "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200"
                            )}
                          >
                            {isListening ? "Stop" : <Mic size={14} />}
                          </button>
                          <button
                            type="submit"
                            className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-1.5 rounded-lg text-xs shadow-sm transition-all"
                          >
                            Svara
                          </button>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* External quick-open buttons */}
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <a
                      href="https://notebooklm.google.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-[#1a73e8] hover:bg-[#1557b0] text-white text-[11px] font-bold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 shadow-sm transition-all text-center"
                    >
                      <span>Öppna NotebookLM</span>
                      <ExternalLink size={12} />
                    </a>
                    <a
                      href="https://gemini.google.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:opacity-95 text-white text-[11px] font-bold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 shadow-sm transition-all text-center"
                    >
                      <span>Öppna Gemini Live</span>
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>

                {/* Collapsible NotebookLM Export Drawer at the very bottom */}
                <div className="border-t border-blue-100 bg-white shrink-0">
                  <button
                    type="button"
                    onClick={() => setExportDrawerOpen(!exportDrawerOpen)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100/50 transition-colors select-none text-xs font-bold text-slate-700"
                  >
                    <div className="flex items-center gap-2">
                      <Layers size={14} className="text-blue-600" />
                      <span>NOTEBOOKLM EXPORT & KÄLLOR</span>
                      <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
                        {notebookLmLinks.length} st
                      </span>
                    </div>
                    {exportDrawerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>

                  <AnimatePresence>
                    {exportDrawerOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="p-4 bg-white flex flex-col gap-3 border-t border-slate-100 overflow-hidden"
                      >
                        {/* Segmented export option toggle */}
                        <div className="grid grid-cols-2 bg-slate-100 p-0.5 rounded-lg text-center text-[10.5px] font-bold select-none">
                          <button
                            type="button"
                            onClick={() => setOnlyNotebookLM(true)}
                            className={cn(
                              "py-1 rounded-md transition-all",
                              onlyNotebookLM 
                                ? "bg-white text-slate-800 shadow-sm" 
                                : "text-slate-500 hover:text-slate-800"
                            )}
                          >
                            Källor (Rekommenderas)
                          </button>
                          <button
                            type="button"
                            onClick={() => setOnlyNotebookLM(false)}
                            className={cn(
                              "py-1 rounded-md transition-all",
                              !onlyNotebookLM 
                                ? "bg-white text-slate-800 shadow-sm" 
                                : "text-slate-500 hover:text-slate-800"
                            )}
                          >
                            Alla funna länkar
                          </button>
                        </div>

                        <div className="bg-slate-900 rounded-lg p-3 font-mono text-[10.5px] text-emerald-400 overflow-y-auto max-h-32 leading-relaxed border border-slate-800 shadow-inner">
                          {categories ? (
                            <pre className="whitespace-pre-wrap break-all select-all">
                              {notebookLmLinks.length > 0 
                                ? notebookLmLinks.join("\n") 
                                : "// Inga matchande källor. Justera filter eller sökning."}
                            </pre>
                          ) : (
                            <div className="h-full flex flex-col items-center justify-center opacity-50 text-slate-400 space-y-1 py-4 text-center">
                              <Layers size={18} />
                              <p className="text-[10px]">Kör autogruppering först för att filtrera optimala källor.</p>
                            </div>
                          )}
                        </div>

                        <button
                          onClick={handleCopy}
                          disabled={notebookLmLinks.length === 0}
                          className={cn(
                            "w-full font-bold py-2 text-xs rounded-lg flex items-center justify-center gap-2 shadow-sm transition-all active:scale-[0.98]",
                            copied
                              ? "bg-emerald-600 text-white"
                              : "bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          {copied ? (
                            <>
                              <CheckCircle2 size={14} />
                              <span>KOPIERAT TILL URKLIPP</span>
                            </>
                          ) : (
                            <>
                              <Copy size={14} />
                              <span>KOPIERA KÄLLOR FÖR NOTEBOOKLM</span>
                            </>
                          )}
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

            </motion.section>
          )}
        </AnimatePresence>
      </main>

      {/* Global minimal styling tweaks */}
      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}
