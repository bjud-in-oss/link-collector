import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
