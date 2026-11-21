import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import useSWR from "swr";
import DemoAutopilotScreen from "./DemoAutopilotScreen";
import EbayListingsSection from "./EbayListingsSection";
import { clearStoredRefreshToken, readStoredRefreshToken, storeRefreshToken } from "./mobileSession";
import { PAPER_BUILD_GUARDRAILS, PAPER_BUILD_MARKER } from "./paperBuild";

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

type Deal = {
  id: string;
  title: string;
  productUrl: string;
  currency: string;
  purchasePriceMinor: string;
  totalCostCents: string;
  expectedProfitCents: string;
  simulated: boolean;
  riskPassed: boolean;
  riskReasons: string[];
  reviewStatus: string;
};
type Finding = {
  role: string;
  status: string;
  summary: string;
  confidence: number;
  uncertainties: string[];
};
type Assessment = {
  status: string;
  score: number;
  valuation_status: string;
  resale_value_low_minor: number | null;
  resale_value_high_minor: number | null;
  estimated_net_low_minor: number | null;
  estimated_net_high_minor: number | null;
  comparable_count: number;
  currency: string;
  confidence: number;
  findings: Finding[];
  conflicts: string[];
  next_actions: string[];
  purchase_authorized: boolean;
};
type Task = {
  taskId: string;
  status: string;
  result?: {
    assessment?: Assessment;
    visual_inspection?: {
      identified?: boolean;
      exact_model?: string;
      condition_grade?: string;
      details?: string;
      uncertainty_notes?: string[];
    };
    purchase_authorized?: boolean;
    authenticity_verified?: boolean;
  } | null;
  hasError?: boolean;
};
type AuthTokenPair = {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};
type ApiRequestInit = { method?: string; headers?: Record<string, string>; body?: string };
type AuthenticatedFetch = (url: string, init?: ApiRequestInit) => Promise<Response>;
type AppSection = "listings" | "demo" | "vision";

const ACTIVE_TASK_STATUSES = new Set(["QUEUED", "RUNNING", "CHECKPOINTED"]);
const isActiveTask = (status: string) => ACTIVE_TASK_STATUSES.has(status);

const roleLabels: Record<string, string> = {
  visual_identification: "Bild- & Modell-Erkennung",
  market_research: "Markt- & Verkaufspreise",
  collector_rarity: "Sammlerwert & Seltenheit",
  technical_parts: "Technik & Ersatzteile",
  restoration: "Zustand & Restaurierung",
  risk_authenticity: "Risiko & Echtheitsindikatoren",
};
const money = (minor: number | null, currency = "EUR") =>
  minor === null ? "Keine belastbare Bewertung" :
    new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(minor / 100);

async function apiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; detail?: string };
    return body.error ?? body.detail ?? "API_REQUEST_FAILED";
  } catch {
    return "API_REQUEST_FAILED";
  }
}
function Panel({ children }: { children: React.ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}
function ActionButton({ title, onPress, disabled = false }: {
  title: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, (pressed || disabled) && styles.buttonMuted]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}
function TaskResult({ task, authenticatedFetch }: { task: Task; authenticatedFetch: AuthenticatedFetch }) {
  const { data: latestTask, error } = useSWR<Task>(
    isActiveTask(task.status) ? `${API_BASE_URL}/v1/treasure-analyses/${encodeURIComponent(task.taskId)}` : null,
    async (url: string) => {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(await apiError(response));
      return await response.json() as Task;
    },
    {
      refreshInterval: (latest) => !latest || isActiveTask(latest.status) ? 2_000 : 0,
      revalidateOnFocus: false,
    },
  );
  const currentTask = latestTask ?? task;
  const assessment = currentTask.result?.assessment;
  const visual = currentTask.result?.visual_inspection;
  return (
    <Panel>
      <View style={styles.rowBetween}>
        <Text style={styles.panelTitle}>Agenten-Ergebnis</Text>
        <Text style={styles.status}>{currentTask.status}</Text>
      </View>
      {visual && (
        <View style={styles.subPanel}>
          <Text style={styles.itemTitle}>Visuelle Identifikation</Text>
          <Text style={styles.bodyText}>Modell: {visual.exact_model ?? "Unbekannt"}</Text>
          <Text style={styles.bodyText}>Zustand: {visual.condition_grade ?? "Unklar"}</Text>
          {!!visual.details && <Text style={styles.muted}>{visual.details}</Text>}
          {visual.uncertainty_notes?.map((note, index) => <Text key={`${index}-${note}`} style={styles.warning}>{note}</Text>)}
        </View>
      )}
      {assessment ? (
        <>
          <View style={styles.scoreRow}>
            <View><Text style={styles.metric}>{assessment.score}/100</Text><Text style={styles.muted}>Fund-Score</Text></View>
            <View><Text style={styles.metric}>{Math.round(assessment.confidence * 100)}%</Text><Text style={styles.muted}>Konfidenz</Text></View>
            <View><Text style={styles.metric}>{assessment.comparable_count}</Text><Text style={styles.muted}>Vergleichsverkäufe</Text></View>
          </View>
          <Text style={styles.itemTitle}>Bewertung · {assessment.valuation_status}</Text>
          <Text style={styles.bodyText}>Geschätzter Wiederverkauf: {money(assessment.resale_value_low_minor, assessment.currency)} – {money(assessment.resale_value_high_minor, assessment.currency)}</Text>
          <Text style={styles.bodyText}>Netto-Spanne vor weiteren unbekannten Kosten: {money(assessment.estimated_net_low_minor, assessment.currency)} – {money(assessment.estimated_net_high_minor, assessment.currency)}</Text>
          {assessment.findings.map((finding) => (
            <View key={finding.role} style={styles.finding}>
              <View style={styles.rowBetween}>
                <Text style={styles.findingTitle}>{roleLabels[finding.role] ?? finding.role}</Text>
                <Text style={styles.status}>{finding.status}</Text>
              </View>
              <Text style={styles.bodyText}>{finding.summary}</Text>
              <Text style={styles.muted}>Konfidenz: {Math.round(finding.confidence * 100)}%</Text>
              {finding.uncertainties.map((item, index) => <Text key={`${index}-${item}`} style={styles.warning}>{item}</Text>)}
            </View>
          ))}
          {assessment.conflicts.map((item, index) => <Text key={index} style={styles.warning}>{item}</Text>)}
          {assessment.next_actions.map((item, index) => <Text key={index} style={styles.muted}>Nächster Schritt: {item}</Text>)}
        </>
      ) : isActiveTask(currentTask.status) ? (
        <View style={styles.progress}><ActivityIndicator color="#8DB5FF" /><Text style={styles.bodyText}>Spezialisten analysieren den Fund. Der Status wird automatisch aktualisiert.</Text></View>
      ) : <Text style={styles.warning}>Noch kein Analyseergebnis vorhanden. Status und Fehlerprotokoll im Backend prüfen.</Text>}
      {error && isActiveTask(currentTask.status) && <Text style={styles.muted}>Verbindung unterbrochen; die Statusabfrage wird erneut versucht.</Text>}
      <Text style={styles.safetyNote}>Keine Echtheitsgarantie · keine Kauf-Freigabe · keine Verkäuferkontaktaufnahme.</Text>
    </Panel>
  );
}

export default function AutopilotDashboard() {
  const [activeSection, setActiveSection] = useState<AppSection>("listings");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const refreshTokenRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef<Promise<AuthTokenPair> | null>(null);

  const rotateRefreshToken = useCallback(async (refreshToken: string): Promise<AuthTokenPair> => {
    if (refreshInFlightRef.current) return await refreshInFlightRef.current;
    const request = (async () => {
      const response = await fetch(API_BASE_URL + "/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          refreshTokenRef.current = null;
          accessTokenRef.current = null;
          await clearStoredRefreshToken();
        }
        throw new Error(await apiError(response));
      }
      const tokens = await response.json() as AuthTokenPair;
      await storeRefreshToken(tokens.refreshToken);
      refreshTokenRef.current = tokens.refreshToken;
      return tokens;
    })();
    refreshInFlightRef.current = request;
    try {
      return await request;
    } finally {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
    }
  }, []);

  const {
    data: restoredSession,
    error: sessionLoadError,
    isLoading: sessionLoading,
    mutate: mutateSession,
  } = useSWR<AuthTokenPair | null>(
    API_BASE_URL ? "autonomagent-mobile-session" : null,
    async () => {
      const refreshToken = await readStoredRefreshToken();
      if (!refreshToken) return null;
      refreshTokenRef.current = refreshToken;
      return await rotateRefreshToken(refreshToken);
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  useEffect(() => {
    if (restoredSession) {
      accessTokenRef.current = restoredSession.accessToken;
      refreshTokenRef.current = restoredSession.refreshToken;
      setAccessToken(restoredSession.accessToken);
    } else if (restoredSession === null) {
      accessTokenRef.current = null;
      refreshTokenRef.current = null;
      setAccessToken(null);
    }
  }, [restoredSession]);

  const authenticatedFetch = useCallback<AuthenticatedFetch>(async (url, init = {}) => {
    const sendWithToken = (token: string) => fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: "Bearer " + token },
    });
    const currentToken = accessTokenRef.current;
    if (!currentToken) throw new Error("AUTHENTICATION_REQUIRED");
    const response = await sendWithToken(currentToken);
    if (response.status !== 401) return response;
    const refreshToken = refreshTokenRef.current;
    if (!refreshToken) return response;
    try {
      const tokens = await rotateRefreshToken(refreshToken);
      accessTokenRef.current = tokens.accessToken;
      setAccessToken(tokens.accessToken);
      await mutateSession(tokens, false);
      return await sendWithToken(tokens.accessToken);
    } catch {
      if (!refreshTokenRef.current) {
        accessTokenRef.current = null;
        setAccessToken(null);
        await mutateSession(null, false);
      }
      return response;
    }
  }, [mutateSession, rotateRefreshToken]);

  const dealsKey: [string, string] | null = API_BASE_URL && accessToken
    ? [API_BASE_URL + "/v1/deals?limit=50", accessToken]
    : null;
  const {
    data: deals = [],
    error: dealsError,
    isLoading: dealsLoading,
    mutate: refreshDeals,
  } = useSWR<Deal[]>(
    dealsKey,
    async ([url]) => {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(await apiError(response));
      const body = await response.json() as { deals: Deal[] };
      return body.deals;
    },
    { revalidateOnFocus: false },
  );

  const signIn = useCallback(async () => {
    if (!API_BASE_URL) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(API_BASE_URL + "/v1/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      const tokens = await response.json() as AuthTokenPair;
      await storeRefreshToken(tokens.refreshToken);
      refreshTokenRef.current = tokens.refreshToken;
      accessTokenRef.current = tokens.accessToken;
      setAccessToken(tokens.accessToken);
      await mutateSession(tokens, false);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LOGIN_FAILED");
    } finally { setBusy(false); }
  }, [email, password, mutateSession]);

  const startAnalysis = useCallback(async (deal: Deal) => {
    if (!accessToken) return;
    const imageUrl = (imageUrls[deal.id] ?? "").trim();
    if (!/^https:\/\//i.test(imageUrl)) {
      setError("Bitte eine HTTPS-Bildadresse eintragen. Die Bilddomain muss serverseitig freigegeben sein.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(API_BASE_URL + "/v1/deals/" + encodeURIComponent(deal.id) + "/treasure-analysis", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": "mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        },
        body: JSON.stringify({ imageUrl }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      const task = await response.json() as { taskId: string; status: string };
      setTasks((current) => ({ ...current, [deal.id]: { taskId: task.taskId, status: task.status } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ANALYSIS_ENQUEUE_FAILED");
    } finally { setBusy(false); }
  }, [accessToken, imageUrls, authenticatedFetch]);

  const signOut = useCallback(async () => {
    const refreshToken = refreshTokenRef.current;
    try {
      if (API_BASE_URL && refreshToken) {
        await fetch(API_BASE_URL + "/v1/auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch { /* Always clear local credentials, even when the API is unavailable. */ }
    try { await clearStoredRefreshToken(); } catch { /* Device storage may be unavailable; clear in-memory credentials regardless. */ }
    accessTokenRef.current = null;
    refreshTokenRef.current = null;
    setAccessToken(null);
    setTasks({});
    setImageUrls({});
    setError(null);
    await mutateSession(null, false);
  }, [mutateSession]);

  const visibleError = error ??
    (dealsError instanceof Error ? dealsError.message : dealsError ? "Kandidaten konnten nicht geladen werden." : null) ??
    (sessionLoadError && !accessToken ? "Die gespeicherte Sitzung konnte nicht erneuert werden. Bitte erneut anmelden." : null);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>AUTONOMAGENT / PAPER WORKSPACE</Text>
        <Text style={styles.heading}>Produkte sicher prüfen</Text>
        <Text style={styles.intro}>Echte Festpreisangebote aus eBay finden, sicher in deinem Konto speichern und ausgewählte Produkte anschließend visuell prüfen.</Text>
        <View style={styles.safetyBanner} testID={PAPER_BUILD_MARKER}>
          <Text style={styles.safetyTitle}>{PAPER_BUILD_GUARDRAILS.tradingMode}-MODUS · KEINE KÄUFE</Text>
          <Text style={styles.muted}>Keine automatischen Gebote, Nachrichten, Zahlungen oder Veröffentlichungen.</Text>
        </View>

        <View style={styles.navigation}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: activeSection === "listings" }}
            onPress={() => setActiveSection("listings")}
            style={[styles.navigationButton, activeSection === "listings" && styles.navigationButtonActive]}
          ><Text style={[styles.navigationText, activeSection === "listings" && styles.navigationTextActive]}>eBay-Angebote</Text></Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: activeSection === "demo" }}
            onPress={() => setActiveSection("demo")}
            style={[styles.navigationButton, activeSection === "demo" && styles.navigationButtonActive]}
          ><Text style={[styles.navigationText, activeSection === "demo" && styles.navigationTextActive]}>Demo-Pilot</Text></Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: activeSection === "vision" }}
            onPress={() => setActiveSection("vision")}
            style={[styles.navigationButton, activeSection === "vision" && styles.navigationButtonActive]}
          ><Text style={[styles.navigationText, activeSection === "vision" && styles.navigationTextActive]}>Vision-Analyse</Text></Pressable>
        </View>

        {activeSection === "demo" ? <DemoAutopilotScreen /> : !API_BASE_URL ? (
          <Panel>
            <Text style={styles.panelTitle}>Live-Backend nicht verbunden</Text>
            <Text style={styles.bodyText}>Für eBay-Angebote, Anmeldung und Bildanalyse muss EXPO_PUBLIC_API_URL auf die erreichbare HTTPS-Adresse der API zeigen. Der lokale Demo-Pilot funktioniert unabhängig davon.</Text>
          </Panel>
        ) : (sessionLoading || Boolean(restoredSession && !accessToken)) && !accessToken ? (
          <Panel><View style={styles.progress}><ActivityIndicator color="#8DB5FF" /><Text style={styles.bodyText}>Gespeicherte Sitzung wird geprüft …</Text></View></Panel>
        ) : !accessToken ? (
          <Panel>
            <Text style={styles.panelTitle}>Administrator-Anmeldung</Text>
            <TextInput accessibilityLabel="E-Mail-Adresse" value={email} onChangeText={setEmail} placeholder="E-Mail" placeholderTextColor="#7183A3" autoCapitalize="none" keyboardType="email-address" style={styles.input} />
            <TextInput accessibilityLabel="Passwort" value={password} onChangeText={setPassword} placeholder="Passwort" placeholderTextColor="#7183A3" secureTextEntry style={styles.input} />
            <ActionButton title={busy ? "Anmeldung läuft …" : "Sicher anmelden"} onPress={() => void signIn()} disabled={busy || !email.trim() || !password} />
            <Text style={styles.muted}>Das Refresh-Token wird auf iOS/Android sicher gespeichert. Im Web bleibt die Sitzung nur im Arbeitsspeicher.</Text>
          </Panel>
        ) : activeSection === "listings" ? (
          <>
            <EbayListingsSection apiBaseUrl={API_BASE_URL} authenticatedFetch={authenticatedFetch} />
            <ActionButton title="Abmelden" onPress={() => void signOut()} />
          </>
        ) : (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Produktkandidaten</Text>
              <Pressable accessibilityRole="button" onPress={() => void refreshDeals().catch((cause) => setError(String(cause)))}><Text style={styles.link}>Aktualisieren</Text></Pressable>
            </View>
            {dealsLoading ? <Panel><View style={styles.progress}><ActivityIndicator color="#8DB5FF" /><Text style={styles.bodyText}>Produktkandidaten werden geladen …</Text></View></Panel> : deals.length === 0 ? <Panel><Text style={styles.bodyText}>Keine Produktkandidaten gefunden. Zuerst Produkte über eine angeschlossene Datenquelle erfassen.</Text></Panel> :
              deals.map((deal) => (
                <Panel key={deal.id}>
                  <Text style={styles.itemTitle}>{deal.title}</Text>
                  <Text style={styles.muted}>{deal.simulated ? "DEMO-DATENSATZ" : "PROVIDER-DATENSATZ"} · {deal.reviewStatus} · {deal.currency}</Text>
                  <Text style={styles.bodyText}>Angebotspreis: {money(Number(deal.purchasePriceMinor), deal.currency)}</Text>
                  <Text style={styles.bodyText}>Gesamtkosten: {money(Number(deal.totalCostCents), deal.currency)}</Text>
                  <Text style={styles.muted}>{deal.riskPassed ? "Regelprüfung bestanden" : "Risiko-Prüfung offen"} · {deal.riskReasons.join(", ")}</Text>
                  <TextInput accessibilityLabel={`HTTPS-Bildadresse für ${deal.title}`} value={imageUrls[deal.id] ?? ""} onChangeText={(value) => setImageUrls((current) => ({ ...current, [deal.id]: value }))}
                    placeholder="HTTPS-Bildadresse des Produkts" placeholderTextColor="#7183A3" autoCapitalize="none" style={styles.input} />
                  <ActionButton title={busy ? "Bitte warten …" : "6 Spezialisten analysieren lassen"}
                    onPress={() => void startAnalysis(deal)} disabled={busy || !deal.id} />
                  {tasks[deal.id] && <TaskResult task={tasks[deal.id]!} authenticatedFetch={authenticatedFetch} />}
                </Panel>
              ))
            }
            <ActionButton title="Abmelden" onPress={() => void signOut()} />
          </>
        )}
        {visibleError && <Text accessibilityRole="alert" style={styles.error}>{visibleError}</Text>}
        {activeSection === "vision" && <Text style={styles.footer}>Verkaufspreise werden nur bei ausreichend aktuellen, belegten Vergleichsverkäufen ausgewiesen. Ohne echte Marktdaten bleibt die Bewertung offen. Keine Echtheitszertifizierung oder Kaufempfehlung.</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#080D18" },
  container: { padding: 20, gap: 12, paddingBottom: 42 },
  eyebrow: { color: "#8DA6D1", fontSize: 10, letterSpacing: 2, fontWeight: "800" },
  heading: { color: "#F3F6FF", fontSize: 30, fontWeight: "900" },
  intro: { color: "#AAB8D1", fontSize: 13, lineHeight: 20 },
  safetyBanner: { backgroundColor: "#251E13", borderColor: "#745B2A", borderWidth: 1, borderRadius: 12, padding: 13, gap: 5 },
  safetyTitle: { color: "#F3C979", fontSize: 12, fontWeight: "900" },
  section: { color: "#E8EEFC", fontSize: 18, fontWeight: "800" },
  navigation: { flexDirection: "row", gap: 8, backgroundColor: "#0C1422", borderRadius: 12, padding: 4 },
  navigationButton: { flex: 1, paddingVertical: 11, borderRadius: 9, alignItems: "center" },
  navigationButtonActive: { backgroundColor: "#263B5C" },
  navigationText: { color: "#8394B2", fontSize: 12, fontWeight: "700" },
  navigationTextActive: { color: "#EDF2FF" },
  panel: { backgroundColor: "#121B2C", borderColor: "#293750", borderWidth: 1, borderRadius: 15, padding: 14, gap: 10 },
  subPanel: { backgroundColor: "#0C1422", borderRadius: 10, padding: 10, gap: 4 },
  panelTitle: { color: "#F4F7FF", fontSize: 15, fontWeight: "800" },
  itemTitle: { color: "#EDF2FF", fontSize: 15, fontWeight: "800" },
  bodyText: { color: "#B9C6DD", fontSize: 12, lineHeight: 18 },
  muted: { color: "#8394B2", fontSize: 10, lineHeight: 15 },
  input: { backgroundColor: "#0B1423", borderWidth: 1, borderColor: "#30405B", borderRadius: 9, padding: 12, color: "#F3F6FF", fontSize: 13 },
  button: { backgroundColor: "#315BB0", padding: 13, borderRadius: 10, alignItems: "center" },
  buttonMuted: { opacity: 0.55 },
  buttonText: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  link: { color: "#91B7FF", fontSize: 12, fontWeight: "800" },
  status: { color: "#F1C875", fontSize: 10, fontWeight: "800" },
  scoreRow: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 8 },
  metric: { color: "#A9C5FF", fontSize: 20, fontWeight: "900" },
  finding: { borderTopWidth: 1, borderTopColor: "#2B3A53", paddingTop: 8, gap: 4 },
  findingTitle: { color: "#E5ECFB", fontSize: 12, fontWeight: "800", flex: 1 },
  warning: { color: "#F0C178", fontSize: 11, lineHeight: 16 },
  progress: { flexDirection: "row", alignItems: "center", gap: 10 },
  safetyNote: { color: "#E2B96E", fontSize: 10, lineHeight: 15 },
  error: { color: "#FF9E9E", backgroundColor: "#351C23", borderRadius: 9, padding: 10, fontSize: 12 },
  footer: { color: "#6E7E99", fontSize: 10, lineHeight: 16, textAlign: "center", marginTop: 14 },
});
