import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import http from "http";
import { WebSocketServer } from "ws";

// Initialize Gemini SDK. Defaults to taking GEMINI_API_KEY from environment variables.
const ai = new GoogleGenAI({});

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.post("/api/extract-links", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter" });
      }

      // 1. Fetch the target URL
      console.log(`Fetching URL: ${url}`);
      let html = "";
      try {
        const response = await client.get(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
          maxRedirects: 15,
          timeout: 15000,
        });
        html = response.data;
      } catch (err: any) {
        console.error("Axios fetch error:", err.message);
        return res.status(500).json({ error: `Misslyckades att hämta URL: ${err.message}` });
      }
      
      // 2. Extract links using Cheerio
      const $ = cheerio.load(html);
      const rawLinks: { url: string; text: string }[] = [];
      const seenUrls = new Set<string>();

      $("a[href]").each((i, el) => {
        let href = $(el).attr("href");
        let text = $(el).text().trim().replace(/\s+/g, " ");

        // Ignore empty hrefs, internal anchors, mailto, tel, JS, etc.
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
          return;
        }

        try {
          // Resolve relative URLs to absolute and strip fragment/hash identifier
          const urlObj = new URL(href, url);
          urlObj.hash = "";
          const absoluteUrl = urlObj.href;

          // Deduplicate urls
          if (!seenUrls.has(absoluteUrl)) {
            seenUrls.add(absoluteUrl);
            rawLinks.push({ url: absoluteUrl, text: text || "Ingen länktext" });
          }
        } catch (e) {
          // invalid url format, skip
        }
      });

      console.log(`Extracted ${rawLinks.length} unique links.`);

      res.json({ links: rawLinks });

    } catch (error: any) {
      console.error("Link extraction error:", error);
      res.status(500).json({ error: error.message || "Ett internt serverfel uppstod." });
    }
  });

  app.post("/api/analyze-links", async (req, res) => {
    try {
      const { url, links } = req.body;
      if (!url || !links || !Array.isArray(links)) {
        return res.status(400).json({ error: "Missing 'url' or 'links' parameter" });
      }

      if (links.length === 0) {
        return res.json({ categories: [] });
      }

      // If we got thousands of links, let's limit it to avoid massive token usage/latency
      const linksToAnalyze = links.slice(0, 400);

      const prompt = `Här är en lista med länkar ($URL - $TEXT) som extraherats från sidan ${url}. 
Din uppgift är att:
1. Analysera länkarna och dela in dem i logiska kategorier (t.ex. "Dokumentation", "API Referens", "Artiklar", "Navigering", "Externa resurser", "Sociala Medier").
2. Identifiera vilka länkar som innehåller tät, textrik eller primär information som är **perfekt lämpad att kopiera in i en AI-kunskapsbas som Google NotebookLM**. Filtrera bort korta navigeringslänkar, inloggningssidor, sociala mediers profiler, "Glömt lösenord", "Hem" eller dylikt. En bra NotebookLM-källa är oftast en referenssida, artikel, dokumentation, tutorial etc. Markera dessa som \`isIdealForNotebookLM: true\`.
3. Svara alltid på Sveska.

Länkar:
${linksToAnalyze.map(l => `- ${l.url} (${l.text})`).join("\n")}`;

      const schema: Schema = {
        type: Type.OBJECT,
        properties: {
          categories: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                links: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      url: { type: Type.STRING },
                      text: { type: Type.STRING },
                      isIdealForNotebookLM: { type: Type.BOOLEAN }
                    },
                    required: ["url", "text", "isIdealForNotebookLM"]
                  }
                }
              },
              required: ["name", "links"]
            }
          }
        },
        required: ["categories"]
      };

      console.log("Analyzing links with Gemini...");
      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.2
        }
      });

      if (!aiResponse.text) {
        throw new Error("Empty response from AI");
      }

      const result = JSON.parse(aiResponse.text);
      res.json(result);

    } catch (error: any) {
      console.error("Link analysis error:", error);
      res.status(500).json({ error: error.message || "Ett internt serverfel uppstod." });
    }
  });

  // Vite middleware for development or Static files for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // WebSocket Server Setup
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const systemInstruction = `Du är "H" - en röststyrd svensk diskussionsledare och guide för Handboken för Jesu Kristi Kyrka av Sista Dagars heliga.
Din uppgift är att guida användaren genom 5 enkla steg för att förbereda sig för att prata med handboken:

Steg 0: Välkomna dem till verktyget och berätta att du hjälper dem hela vägen. Säg till exempel: "Hej! Jag är din röststyrda diskussionsledare H. Vill du starta processen för att tala med handboken?"
Steg 1: Berätta att de ska klicka på knappen "1. HÄMTA LÄNKAR" på skärmen för att hämta de 44 handbokskällorna. De kopieras automatiskt till deras urklipp.
Steg 2: När de har klickat på den, be dem klicka på knappen "2. ÖPPNA NOTEBOOKLM" för att öppna NotebookLM, klicka på "Skapa ny notebook" och klistra in länkarna från urklippet. Be dem säga till när de har gjort det.
Steg 3: Nu är handboken laddad i deras Notebook. Tipsa dem om att testa att chatta i NotebookLM (till exempel genom att ställa en fråga som "Vad säger handboken om stöd till familjer?"). Fråga dem hur det gick när de är klara.
Steg 4: Nu kommer det absolut viktigaste steget! Förklara detta EXAKTA steg för hur man sätter upp det i Gemini:
"Innan man trycker mikrofonen i Gemini skall man trycka + knappen till vänster om chattrutan och sen gå till menyvalet 'Fler uppladdningar' och där väljer man Notebooks. Då visas en lista över anteckningsböcker där du väljer den översta i listan (Notebooken du nyss skapade) och klickar 'infoga'."
När detta är gjort, förklara hur de kan prata och få bäst svar:
"Nu kan du prata direkt med handboken! Du kan turas om att prata med hjälp av mikrofonsymbolen för att få bäst och mest detaljerade svar, eller så skriver man i chatten, eller så trycker man på live-symbolen för en live-röstchatt som ger en mer naturlig dialog med handboken men inte lika detaljerade svar."

Håll dina svar korta, extremt trevliga och engagerande på ren svenska. Svara naturligt och led användaren framåt steg för steg.`;

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    if (pathname === "/live-ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs, request) => {
    console.log("Client connected to Gemini Live WS bridge.");
    
    // Extract API Key from query params or environment
    const { searchParams } = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    const clientApiKey = searchParams.get("apiKey");
    const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

    if (!activeApiKey) {
      console.error("No Gemini API key available for Live session.");
      clientWs.send(JSON.stringify({ type: "error", error: "Ingen API-nyckel hittades. Vänligen ange din Gemini API-nyckel i inställningarna." }));
      clientWs.close();
      return;
    }

    try {
      const liveAi = new GoogleGenAI({
        apiKey: activeApiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          }
        }
      });

      console.log("Connecting to Gemini Live API...");
      const session = await liveAi.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: ["AUDIO"] as any,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, // Zephyr, Kore, Fenrir, Puck, Charon
          },
          systemInstruction,
        },
        callbacks: {
          onmessage: (message: any) => {
            // 1. Send text transcriptions back if available
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  clientWs.send(JSON.stringify({ type: "text", text: part.text }));
                }
              }
            }

            // 2. Handle model output audio chunk
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }

            // 3. Handle interruption
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed internally");
            clientWs.close();
          },
          onerror: (err: any) => {
            console.error("Gemini Live error:", err);
            clientWs.send(JSON.stringify({ type: "error", error: err.message || "Ett fel uppstod i Gemini Live" }));
          }
        },
      });

      console.log("Gemini Live connected successfully.");

      // Receive audio/text from the client and forward to Gemini
      clientWs.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            await session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (msg.text) {
            // Send text input if user types
            await session.sendRealtimeInput({
              text: msg.text,
            });
          }
        } catch (e: any) {
          console.error("Error processing user input to Live session:", e);
        }
      });

      clientWs.on("close", () => {
        console.log("Client closed connection. Closing Gemini Live session.");
        session.close();
      });

    } catch (err: any) {
      console.error("Failed to connect to Gemini Live session:", err);
      clientWs.send(JSON.stringify({ type: "error", error: `Kunde inte starta Gemini Live-session: ${err.message}` }));
      clientWs.close();
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
