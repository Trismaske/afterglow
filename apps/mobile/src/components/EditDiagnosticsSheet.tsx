/**
 * Gate-0 editor-launch diagnostic matrix — the impure driver (m0.7 item A).
 * Runs the environment probe automatically, then walks the tester through
 * the dispatch probes one at a time: each probe fires a real intent, the
 * tester returns to Afterglow and records whether an app actually opened
 * (dispatch success alone does not prove the target drew a screen). The
 * write-request branch appears only when a probe hit a SecurityException,
 * per plan item A. Sequencing/branching is pure `lib/editMatrix.ts`; this
 * component only binds it to the native module and renders a shareable
 * report for the Samsung round-trip.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import {
  probeEditLaunch,
  requestMediaWriteAccess,
  runEditDiagnostics,
  type EditDiagnosticsReport,
} from '../../modules/media-store-actions';
import { getEditableContentUriDetailed } from '../lib/media';
import {
  MATRIX_PROBES,
  WRITE_REQUEST_TITLE,
  formatMatrixReport,
  nextMatrixStep,
  type MatrixRecord,
  type MatrixStepId,
  type MatrixUriInfo,
} from '../lib/editMatrix';
import { colors, touch } from '../theme';

interface Props {
  assetId: string;
  onClose: () => void;
}

function envLines(env: EditDiagnosticsReport | null): (readonly [string, string])[] {
  if (!env) return [['Environment', 'native module unavailable']];
  return [
    ['Device', env.device],
    ['Android SDK', env.sdkInt],
    ['App package', env.myPackage],
    ['App UID', env.myUid],
    ['checkUriPermission read', env.readPerm],
    ['checkUriPermission write', env.writePerm],
    ['openInputStream', env.openStream],
    ['Visible EDIT handlers (may be partial)', env.editHandlers],
    ['Visible VIEW handlers (may be partial)', env.viewHandlers],
  ];
}

export function EditDiagnosticsSheet({ assetId, onClose }: Props) {
  const [uriInfo, setUriInfo] = useState<MatrixUriInfo | null>(null);
  const [env, setEnv] = useState<EditDiagnosticsReport | null>(null);
  const [envDone, setEnvDone] = useState(false);
  const [records, setRecords] = useState<MatrixRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [awaitingObservation, setAwaitingObservation] = useState<MatrixStepId | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await getEditableContentUriDetailed(assetId);
      if (cancelled) return;
      setUriInfo(info);
      const report = await runEditDiagnostics(info.uri);
      if (cancelled) return;
      setEnv(report);
      setEnvDone(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const next = useMemo(() => nextMatrixStep(records), [records]);

  const runStep = useCallback(
    async (step: MatrixStepId) => {
      if (!uriInfo || running) return;
      setRunning(true);
      try {
        if (step === 'write_request') {
          // A REJECTION (no activity / bridge failure) is itself a matrix
          // datum — record it as 'error' so the matrix can complete for
          // exactly this failure mode instead of sticking on this step.
          let dispatch: MatrixRecord['dispatch'];
          try {
            const { status } = await requestMediaWriteAccess([uriInfo.uri]);
            dispatch = {
              result:
                status === 'applied'
                  ? 'approved'
                  : status === 'cancelled'
                    ? 'cancelled'
                    : 'unsupported',
              message: `consent dialog: ${status}`,
            };
          } catch (error) {
            dispatch = {
              result: 'error',
              message: error instanceof Error ? error.message : String(error),
            };
          }
          setRecords((prev) => [...prev, { step, dispatch }]);
          return;
        }
        const probe = MATRIX_PROBES[step];
        const dispatch = await probeEditLaunch(uriInfo.uri, probe.action, probe.withWrite);
        setRecords((prev) => [...prev, { step, dispatch }]);
        if (dispatch.result === 'launched') setAwaitingObservation(step);
      } finally {
        setRunning(false);
      }
    },
    [uriInfo, running],
  );

  const recordObservation = useCallback((step: MatrixStepId, observedOpen: boolean) => {
    setRecords((prev) => prev.map((r) => (r.step === step ? { ...r, observedOpen } : r)));
    setAwaitingObservation(null);
  }, []);

  const report = useMemo(
    () =>
      uriInfo ? formatMatrixReport(envLines(env), uriInfo, records) : 'Resolving content URI…',
    [env, uriInfo, records],
  );

  const shareReport = useCallback(() => {
    void Share.share({ message: report });
  }, [report]);

  const nextTitle =
    next === null
      ? null
      : next === 'write_request'
        ? WRITE_REQUEST_TITLE
        : MATRIX_PROBES[next].title;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Editor-launch matrix</Text>
          <Text style={styles.hint}>
            Each step fires a real intent. When an app opens, come back to Afterglow and record what
            you saw. Share the report when the matrix completes.
          </Text>
          <ScrollView style={styles.reportScroll}>
            <Text selectable style={styles.report}>
              {report}
            </Text>
          </ScrollView>
          {awaitingObservation !== null ? (
            <View style={styles.actions}>
              <Text style={styles.observePrompt}>Did an app open?</Text>
              <Pressable
                style={[styles.button, styles.primary]}
                onPress={() => recordObservation(awaitingObservation, true)}
              >
                <Text style={styles.buttonText}>An app opened</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.warn]}
                onPress={() => recordObservation(awaitingObservation, false)}
              >
                <Text style={styles.buttonText}>Nothing opened</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.actions}>
              {envDone && next !== null ? (
                <Pressable
                  style={[styles.button, styles.primary]}
                  disabled={running || !uriInfo}
                  onPress={() => void runStep(next)}
                >
                  <Text style={styles.buttonText}>
                    {running ? 'Running…' : `Run: ${nextTitle}`}
                  </Text>
                </Pressable>
              ) : null}
              {envDone && next === null ? (
                <Pressable style={[styles.button, styles.primary]} onPress={shareReport}>
                  <Text style={styles.buttonText}>Share report</Text>
                </Pressable>
              ) : null}
              <Pressable style={[styles.button, styles.neutral]} onPress={onClose}>
                <Text style={styles.buttonText}>Close</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: touch.radius,
    borderTopRightRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    maxHeight: '88%',
    gap: 10,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  hint: { color: colors.textDim, fontSize: 13 },
  reportScroll: { flexGrow: 0 },
  report: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'monospace',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 10,
    padding: 10,
  },
  actions: { gap: 8 },
  observePrompt: { color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  button: {
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  primary: { backgroundColor: colors.editDim, borderWidth: 1, borderColor: colors.edit },
  warn: { backgroundColor: colors.cullDim, borderWidth: 1, borderColor: colors.cull },
  neutral: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
