import type { Label } from "./rules.ts";

// The words of the "Sekarang" hero (plan P14): the label in plain, kind language, in the tone of
// Gentler Streak and LookAway (no blame, no alarm, a next step). The label name itself stays in
// the chip next to it; specific advice comes from the Langflow flow, so no durations here.

export type HeroState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "uncalibrated" }
  | { kind: "calibrating" }
  | { kind: "analyzing" }
  | { kind: "label"; label: Label };

export type HeroCopy = { chip: string; title: string; text: string };

const LABEL_COPY: Record<Label, { title: string; text: string }> = {
  normal: {
    title: "Kamu tampak segar",
    text: "Tidak ada tanda lelah di menit terakhir. Lanjutkan, dan tetap sisipkan jeda sesekali.",
  },
  "lelah ringan": {
    title: "Mulai ada tanda lelah",
    text: "Belum perlu berhenti. Istirahatkan mata sebentar atau minta saran untuk langkah yang pas.",
  },
  lelah: {
    title: "Kamu tampak lelah",
    text: "Tubuhmu memberi sinyal butuh jeda. Berhenti sebentar akan lebih membantu daripada memaksakan diri.",
  },
  tertidur: {
    title: "Sepertinya kamu tertidur",
    text: "Kalau sudah terbangun, bergerak sebentar, dan pertimbangkan istirahat yang cukup sebelum lanjut.",
  },
  "tidak di depan layar": {
    title: "Kamu sedang tidak di depan layar",
    text: "Waktu jauh dari layar 2 menit atau lebih terhitung sebagai jeda.",
  },
};

export function heroCopy(state: HeroState): HeroCopy {
  switch (state.kind) {
    case "loading":
      return {
        chip: "Memuat…",
        title: "Menyiapkan Equilibre…",
        text: "Kamera dan model deteksi sedang dimuat. Semuanya diproses di perangkat ini.",
      };
    case "error":
      return { chip: "Kamera mati", title: "Kamera belum bisa dipakai", text: state.message };
    case "uncalibrated":
      return {
        chip: "Belum dikalibrasi",
        title: "Kenalan dulu, yuk",
        text:
          "Kalibrasi sekitar 5 menit supaya Equilibre mengenal kondisi normalmu: pejamkan mata sebentar saat aba-aba, " +
          "lalu bekerja seperti biasa.",
      };
    case "calibrating":
      return { chip: "Kalibrasi…", title: "Kalibrasi berjalan", text: "Ikuti aba-aba di kamera." };
    case "analyzing":
      return { chip: "Menganalisis…", title: "Sedang membaca kondisimu", text: "Label pertama muncul sekitar 10 detik lagi." };
    case "label":
      return { chip: capitalize(state.label), ...LABEL_COPY[state.label] };
  }
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
