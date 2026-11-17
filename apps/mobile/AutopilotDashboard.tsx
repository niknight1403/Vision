import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";

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
function TaskResult({ task }: { task: Task }) {
  const assessment = task.result?.assessment;
  const visual = task.result?.visual_inspection;
  return (
    <Panel>
      <View style={styles.rowBetween}>
        <Text style={styles.panelTitle}>Agenten-Ergebnis</Text>
        <Text style={styles.status}>{task.status}</Text>
      </View>
      {visual && (
        <View style={styles.subPanel}>
          <Text style={styles.itemTitle}>Visuelle Identifikation</Text>
          <Text style={styles.bodyText}>Modell: {visual.exact_model ?? "Unbekannt"}</Text>
          <Text style={styles.bodyText}>Zustand: {visual.condition_grade ?? "Unklar"}</Text>
          {!!visual.details && <Text style={styles.muted}>{visual.details}</Text>}
        </View>
      )}
      {assessment ? (
        <>
          <View style={styles.scoreRow}>
            <View><Text style={styles.metric}>{assessment.score}/100</Text><Text style={styles.muted}>Fund-Score</Text></View>
            <View><Text style={styles.metric}>{Math.round(assessment.confidence * 100)}%</Text><Text style={styles.muted}>Konfidenz</Text></View>
            <View><Text style={styles.metric}>{assessment.comparable_count}</Text><Text style={styles.muted}>Verkaufspreise</Text></View>
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
            </View>
          ))}
          {assessment.conflicts.map((item, index) => <Text key={index} style={styles.warning}>• {item}</Text>)}
          {assessment.next_actions.map((item, index) => <Text key={index} style={styles.muted}>Nächster Schritt: {item}</Text>)}
        </>
      ) : task.status === "QUEUED" || task.status === "RUNNING" ? (
        <View style={styles.progress}><ActivityIndicator color="#8DB5FF" /><Text style={styles.bodyText}>Spezialisten analysieren den Fund. Ergebnis wird automatisch aktualisiert.</Text></View>
      ) : <Text style={styles.warning}>Noch kein Analyseergebnis vorhanden. Status und Fehlerprotokoll im Backend prüfen.</Text>}
      <Text style={styles.safetyNote}>Keine Echtheitsgarantie · keine Kauf-Freigabe · keine Verkäuferkontaktaufnahme.</Text>
    </Panel>
  );
}

export default function AutopilotDashboard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDeals = useCallback(async (token: string) => {
    const response = await fetch(API_BASE_URL + "/v1/deals?limit=50", {
      headers: { authorization: "Bearer " + token },
    });
    if (!response.ok) throw new Error(await apiError(response));
    const body = await response.json() as { deals: Deal[] };
    setDeals(body.deals);
  }, []);

  const signIn = useCallback(async () => {
    if (!API_BASE_URL) {
      setError("EXPO_PUBLIC_API_URL ist nicht gesetzt. Bitte die API-URL in der App-Build-Umgebung konfigurieren.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const response = await fetch(API_BASE_URL + "/v1/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      const tokens = await response.json() as { accessToken: string };
      setAccessToken(tokens.accessToken); setPassword("");
      await loadDeals(tokens.accessToken);
    } catch (cause) {
      setAccessToken(null);
      setError(cause instanceof Error ? cause.message : "LOGIN_FAILED");
    } finally { setBusy(false); }
  }, [email, password, loadDeals]);

  const startAnalysis = useCallback(async (deal: Deal) => {
    if (!accessToken) return;
    const imageUrl = (imageUrls[deal.id] ?? "").trim();
    if (!/^https:\/\//i.test(imageUrl)) {
      setError("Bitte eine HTTPS-Bildadresse eintragen. Die Bilddomain muss serverseitig freigegeben sein.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const response = await fetch(API_BASE_URL + "/v1/deals/" + encodeURIComponent(deal.id) + "/treasure-analysis", {
        method: "POST",
        headers: {
          authorization: "Bearer " + accessToken,
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
  }, [accessToken, imageUrls]);

  useEffect(() => {
    if (!accessToken) return;
    const active = Object.entries(tasks).filter(([, task]) =>
      task.status === "QUEUED" || task.status === "RUNNING" || task.status === "CHECKPOINTED"
    );
    if (!active.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const [dealId, task] of active) {
        try {
          const response = await fetch(API_BASE_URL + "/v1/treasure-analyses/" + encodeURIComponent(task.taskId), {
            headers: { authorization: "Bearer " + accessToken },
          });
          if (!response.ok) continue;
          const next = await response.json() as Task;
          if (!cancelled) setTasks((current) => ({ ...current, [dealId]: next }));
        } catch { /* keep last known task status after transient network errors */ }
      }
    }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accessToken, tasks]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>AUTONOMAGENT / VISION SWARM</Text>
        <Text style={styles.heading}>Verborgene Schätze</Text>
        <Text style={styles.intro}>Spezialisten prüfen unscheinbare Produkte auf Modellhinweise, Sammlerwert, Ersatzteile, Restaurierung und Risiken.</Text>
        <View style={styles.safetyBanner}>
          <Text style={styles.safetyTitle}>PAPER-MODUS · KEINE KÄUFE</Text>
          <Text style={styles.muted}>Analysen und Fundbewertungen – keine automatischen Gebote, Nachrichten oder Zahlungen.</Text>
        </View>

        {!accessToken ? (
          <Panel>
            <Text style={styles.panelTitle}>Administrator-Anmeldung</Text>
            <TextInput value={email} onChangeText={setEmail} placeholder="E-Mail" placeholderTextColor="#7183A3" autoCapitalize="none" keyboardType="email-address" style={styles.input} />
            <TextInput value={password} onChangeText={setPassword} placeholder="Passwort" placeholderTextColor="#7183A3" secureTextEntry style={styles.input} />
            <ActionButton title={busy ? "Anmeldung läuft …" : "Sicher anmelden"} onPress={() => void signIn()} disabled={busy} />
            <Text style={styles.muted}>Zugangsdaten werden nur für den Login übertragen und nicht lokal gespeichert.</Text>
          </Panel>
        ) : (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Produktkandidaten</Text>
              <Pressable onPress={() => void loadDeals(accessToken).catch((e) => setError(String(e)))}><Text style={styles.link}>Aktualisieren</Text></Pressable>
            </View>
            {deals.length === 0 ? <Panel><Text style={styles.bodyText}>Keine Produktkandidaten gefunden. Zuerst Produkte über eine angeschlossene Datenquelle erfassen.</Text></Panel> :
              deals.map((deal) => (
                <Panel key={deal.id}>
                  <Text style={styles.itemTitle}>{deal.title}</Text>
                  <Text style={styles.muted}>{deal.simulated ? "DEMO-DATENSATZ" : "PROVIDER-DATENSATZ"} · {deal.reviewStatus} · {deal.currency}</Text>
                  <Text style={styles.bodyText}>Angebotspreis: {money(Number(deal.purchasePriceMinor), deal.currency)}</Text>
                  <Text style={styles.bodyText}>Gesamtkosten: {money(Number(deal.totalCostCents), deal.currency)}</Text>
                  <Text style={styles.muted}>{deal.riskPassed ? "Regelprüfung bestanden" : "Risiko-Prüfung offen"} · {deal.riskReasons.join(", ")}</Text>
                  <TextInput value={imageUrls[deal.id] ?? ""} onChangeText={(value) => setImageUrls((current) => ({ ...current, [deal.id]: value }))}
                    placeholder="HTTPS-Bildadresse des Produkts" placeholderTextColor="#7183A3" autoCapitalize="none" style={styles.input} />
                  <ActionButton title={busy ? "Bitte warten …" : "6 Spezialisten analysieren lassen"}
                    onPress={() => void startAnalysis(deal)} disabled={busy || !deal.id} />
                  {tasks[deal.id] && <TaskResult task={tasks[deal.id]!} />}
                </Panel>
              ))
            }
            <ActionButton title="Abmelden" onPress={() => { setAccessToken(null); setDeals([]); setTasks({}); }} />
          </>
        )}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Text style={styles.footer}>Verkaufspreise werden nur bei ausreichend aktuellen, belegten Vergleichsverkäufen ausgewiesen. Ohne echte Marktdaten bleibt die Bewertung offen. Keine Echtheitszertifizierung oder Kaufempfehlung.</Text>
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
