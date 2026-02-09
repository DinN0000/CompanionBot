import * as cheerio from "cheerio";

// URL 내용 캐시 (중복 fetch 방지)
const urlCache = new Map<string, { title: string; content: string; timestamp: number }>();
const URL_CACHE_TTL = 10 * 60 * 1000; // 10분

/**
 * 텍스트에서 URL을 추출합니다.
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  return text.match(urlRegex) || [];
}

/**
 * URL 안전성 검사 (SSRF 방지)
 * 
 * 차단 대상:
 * - 모든 사설 IPv4 (10.x, 172.16-31.x, 192.168.x, 127.x, 0.x, 169.254.x)
 * - 모든 사설/특수 IPv6 (::1, fe80::, fd00::/8, fc00::/7)
 * - IPv4-mapped IPv6 (::ffff:127.0.0.1 등)
 * - 클라우드 메타데이터 엔드포인트
 * - .local, .internal 도메인
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // HTTP/HTTPS만 허용
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // localhost 및 특수 도메인 차단
    if (
      hostname === "localhost" ||
      hostname === "localhost.localdomain" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".localhost")
    ) {
      return false;
    }

    // 클라우드 메타데이터 엔드포인트 차단
    if (
      hostname === "169.254.169.254" || // AWS/GCP/Azure metadata
      hostname === "metadata.google.internal" ||
      (hostname.endsWith(".amazonaws.com") && hostname.includes("metadata"))
    ) {
      return false;
    }

    // IPv4 사설 주소 차단
    const ipv4PrivatePatterns = [
      /^127\./, // 127.0.0.0/8 loopback
      /^10\./, // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
      /^192\.168\./, // 192.168.0.0/16
      /^0\./, // 0.0.0.0/8
      /^169\.254\./, // link-local
    ];

    if (ipv4PrivatePatterns.some((p) => p.test(hostname))) {
      return false;
    }

    // IPv6 사설/특수 주소 차단 (브라켓 제거 후 검사)
    const ipv6Host = hostname.replace(/^\[|\]$/g, "");
    const ipv6PrivatePatterns = [
      /^::1$/, // loopback
      /^fe80:/i, // link-local
      /^fd[0-9a-f]{2}:/i, // unique local (fd00::/8)
      /^fc[0-9a-f]{2}:/i, // unique local (fc00::/7)
      /^::$/,  // unspecified
      // IPv4-mapped IPv6 (::ffff:127.0.0.1 등)
      /^::ffff:(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|0\.|169\.254\.)/i,
    ];

    if (ipv6PrivatePatterns.some((p) => p.test(ipv6Host))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 웹페이지 내용을 가져옵니다.
 * 캐시 지원으로 중복 fetch 방지
 */
export async function fetchWebContent(
  url: string
): Promise<{ title: string; content: string } | null> {
  // SSRF 방지
  if (!isSafeUrl(url)) {
    console.log(`[Security] Blocked unsafe URL: ${url}`);
    return null;
  }

  // 캐시 확인
  const cached = urlCache.get(url);
  if (cached && Date.now() - cached.timestamp < URL_CACHE_TTL) {
    console.log(`[URL] Cache hit: ${url}`);
    return { title: cached.title, content: cached.content };
  }

  try {
    // 10초 타임아웃
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CompanionBot/1.0)",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // 불필요한 요소 제거
    $(
      "script, style, nav, footer, header, aside, .ad, .advertisement"
    ).remove();

    // 제목 추출
    const title =
      $("title").text().trim() || $("h1").first().text().trim() || "제목 없음";

    // 본문 추출 (article, main, body 순으로 시도)
    const mainContent =
      $("article").text() ||
      $("main").text() ||
      $(".content").text() ||
      $("body").text();

    // 텍스트 정리
    const content = mainContent
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000); // 5000 → 3000자로 제한 (토큰 절약)

    // 캐시 저장
    urlCache.set(url, { title, content, timestamp: Date.now() });

    // 캐시 크기 제한 (최대 50개)
    if (urlCache.size > 50) {
      const oldestKey = urlCache.keys().next().value;
      if (oldestKey) urlCache.delete(oldestKey);
    }

    return { title, content };
  } catch (error) {
    console.error("Fetch error:", error);
    return null;
  }
}

/**
 * URL 내용을 컨텍스트용 포맷으로 변환합니다.
 * 히스토리에는 간략한 버전만, 현재 요청에는 전체 내용
 */
export function formatUrlContent(
  url: string,
  content: { title: string; content: string }
): { 
  forHistory: string;  // 히스토리에 저장될 간략 버전
  forContext: string;  // 현재 요청에 주입될 전체 버전
} {
  const forHistory = `[링크: ${content.title}](${url})`;
  const forContext = `\n---\n📎 ${url}\n📌 ${content.title}\n${content.content}\n---`;
  
  return { forHistory, forContext };
}

/**
 * 캐시를 무효화합니다.
 */
export function clearUrlCache(): void {
  urlCache.clear();
}
