import React, { useState, useMemo } from "react";
import { Copy, Dna, Search, Link as LinkIcon, CheckCircle2, FileText, ChevronDown, ChevronRight, Download, Bot, Filter, Layers } from "lucide-react";
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

export default function App() {
  const [url, setUrl] = useState("https://ai.google.dev/api");
  
  // Scanning state
  const [scanLoading, setScanLoading] = useState(false);
  const [rawLinks, setRawLinks] = useState<BasicLink[]>([]);
  const [scanned, setScanned] = useState(false);
  
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
  const [apiKey, setApiKey] = useState("");
  const [onlyNotebookLM, setOnlyNotebookLM] = useState(true);
  const [aiSearchQuery, setAiSearchQuery] = useState("");
  const [aiFiltering, setAiFiltering] = useState(false);
  const [aiFilteredUrls, setAiFilteredUrls] = useState<Set<string> | null>(null);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    
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
        body: JSON.stringify({ url }),
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
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
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
            const urlObj = new URL(href, url);
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

          {/* Filters (only show if we have raw links) */}
          {/* Filters & AI Search (only show if we have raw links) */}
          {scanned && (
            <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
              <div className="flex flex-col md:flex-row gap-3">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Filter className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder="Filtrera på nyckelord eller URL..."
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
              <div className="flex flex-col md:flex-row gap-3 pt-2 border-t border-dashed border-slate-150">
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
                    placeholder="Finsök med AI (t.ex. 'Hitta endast sidor relaterade till autentisering eller inställningar')..."
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
            </div>
          )}

          {error && (
             <div className="mt-2 px-3 py-2 bg-red-50 border border-red-100 rounded text-red-600 text-xs flex items-center gap-2">
              ⚠️ <span>{error}</span>
            </div>
          )}

          {/* Setup for future AI functionality */}
          <div className="mt-4 pt-4 border-t border-slate-100">
            <details className="group" open={!apiKey}>
              <summary className="text-xs font-semibold text-slate-500 cursor-pointer flex items-center gap-1.5 outline-none select-none">
                <ChevronRight size={14} className="group-open:rotate-90 transition-transform" />
                Gemini API-nyckel (Krävs för AI-sökning på Netlify)
              </summary>
              <div className="mt-3 pl-5">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    const val = e.target.value;
                    setApiKey(val);
                    localStorage.setItem("gemini_api_key", val);
                  }}
                  placeholder="Klistra in din Gemini API-nyckel här..."
                  className="w-full max-w-sm bg-slate-50 border border-slate-200 rounded-md py-1.5 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <p className="text-[10px] text-slate-400 mt-1.5">
                  Din nyckel sparas säkert lokalt i din webbläsare (localStorage) och skickas endast till Googles officiella Gemini API vid sökning. Det är helt kostnadsfritt under gratis-nivån för Gemini 2.5 Flash!
                </p>
              </div>
            </details>
          </div>
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

              {/* Right Column: NotebookLM Export */}
              <div className="flex-[2] flex flex-col gap-4 overflow-hidden">
                  <div className="flex flex-col gap-2 shrink-0">
                    <div className="flex items-center justify-between">
                      <h2 className="font-bold text-slate-800">NotebookLM Export</h2>
                      <span className="text-[10px] font-medium text-slate-500">
                        ({notebookLmLinks.length} st rader)
                      </span>
                    </div>

                    {/* Segmented export option toggle */}
                    <div className="grid grid-cols-2 bg-slate-200/60 p-0.5 rounded-lg text-center text-xs font-semibold select-none">
                      <button
                        type="button"
                        onClick={() => setOnlyNotebookLM(true)}
                        className={cn(
                          "py-1.5 rounded-md transition-all",
                          onlyNotebookLM 
                            ? "bg-white text-slate-800 shadow-sm" 
                            : "text-slate-500 hover:text-slate-800"
                        )}
                      >
                        Rekommenderade
                      </button>
                      <button
                        type="button"
                        onClick={() => setOnlyNotebookLM(false)}
                        className={cn(
                          "py-1.5 rounded-md transition-all",
                          !onlyNotebookLM 
                            ? "bg-white text-slate-800 shadow-sm" 
                            : "text-slate-500 hover:text-slate-800"
                        )}
                      >
                        Alla länkar
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex-1 bg-slate-900 rounded-lg p-4 font-mono text-[11px] text-emerald-400 overflow-y-auto leading-relaxed hide-scrollbar border border-slate-800 shadow-inner">
                      {categories ? (
                        <pre className="whitespace-pre-wrap break-all select-all">
                          {notebookLmLinks.length > 0 
                            ? notebookLmLinks.join("\n") 
                            : "// Inga matchande källor. Justera filter eller sökning."}
                        </pre>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center opacity-50 text-slate-400 space-y-3 p-4 text-center">
                          <Layers size={24} />
                          <p>Kör autogruppering för att plocka ut de bästa dokumentationslänkarna för NotebookLM.</p>
                        </div>
                      )}
                  </div>
                  
                  <div className="shrink-0">
                      <button
                        onClick={handleCopy}
                        disabled={notebookLmLinks.length === 0}
                        className={cn(
                          "w-full font-bold py-3 text-xs rounded-lg flex items-center justify-center gap-2 shadow-sm transition-all active:scale-[0.98]",
                          copied
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                      >
                        {copied ? (
                          <>
                            <CheckCircle2 size={16} />
                            <span>KOPIERAT FÖR NOTEBOOKLM</span>
                          </>
                        ) : (
                          <>
                            <Copy size={16} />
                            <span>KOPIERA KÄLLOR</span>
                          </>
                        )}
                      </button>
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
