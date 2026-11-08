import { describe, expect, it } from "vitest";
import type { ImportedTask } from "./googleTasks.ts";
import {
  askedWord,
  daysUntil,
  dueBucket,
  emptyTagMemory,
  findVerb,
  localTagStore,
  memoryTagStore,
  NOT_ASSESSED,
  parseTagMemory,
  rememberTag,
  serializeTagMemory,
  stems,
  STOP_WORDS,
  TAG_MEMORY_KEY,
  TAG_MEMORY_LIMIT,
  tagTask,
  TASK_LEXICON,
  titleWords,
  toAbstractTasks,
  type Rubric,
  type TagMemory,
} from "./taskTagger.ts";

const task = (id: string, title: string, overrides: Partial<ImportedTask> = {}): ImportedTask => ({
  id,
  listId: "L1",
  listTitle: "Work",
  title,
  due: null,
  parent: null,
  order: 0,
  ...overrides,
});

const rubricOf = (title: string, personal: ReadonlyMap<string, Rubric> = new Map()) => {
  const tag = tagTask(task("x", title), "2026-11-08", new Map(), personal);
  return `${tag.sifat} ${tag.beban}`;
};

// Realistic office task titles, English and Indonesian, with the rubric the lexicon should propose.
const SAMPLES: readonly [string, string][] = [
  // English
  ["Write Q3 sales report", "aktif berat"],
  ["Draft proposal for PT Maju", "aktif berat"],
  ["Analyse churn data", "aktif berat"],
  ["Design onboarding flow", "aktif berat"],
  ["Prepare slides for Monday pitch", "aktif berat"],
  ["Review PR #482", "aktif berat"],
  ["Fix login bug on checkout", "aktif berat"],
  ["Debugging payment webhook", "aktif berat"],
  ["Planning session for Q1", "aktif berat"],
  ["Present roadmap to leadership", "aktif berat"],
  ["Call the vendor about shipping", "aktif ringan"],
  ["Meeting with marketing team", "aktif ringan"],
  ["Follow-up with Budi on the invoice", "aktif ringan"],
  ["Check in with new hire", "aktif ringan"],
  ["Reply to Dina's email", "monoton ringan"],
  ["File expense receipts", "monoton ringan"],
  ["Enter timesheet data", "monoton ringan"],
  ["Check inbox", "monoton ringan"],
  ["Update the CRM", "monoton ringan"],
  ["Schedule 1:1 with Sarah", "monoton ringan"],
  ["Sign NDA for vendor", "monoton ringan"],
  ["Emails to the agency", "monoton ringan"],
  ["Reconcile October bank statement", "monoton berat"],
  ["Proofread annual report", "monoton berat"],
  // Indonesian, base words
  ["Tulis laporan bulanan", "aktif berat"],
  ["Revisi proposal klien", "aktif berat"],
  ["Analisis data penjualan", "aktif berat"],
  ["Siapkan bahan presentasi", "aktif berat"],
  ["Presentasi hasil riset ke direksi", "aktif berat"],
  ["Wawancara kandidat staf keuangan", "aktif berat"],
  ["Rapat koordinasi divisi", "aktif ringan"],
  ["Telepon Pak Andi soal kontrak", "aktif ringan"],
  ["Balas email dari HR", "monoton ringan"],
  ["Cek stok gudang", "monoton ringan"],
  ["Kirim invoice ke klien", "monoton ringan"],
  ["Isi form reimburse", "monoton ringan"],
  ["Rekap absensi Oktober", "monoton ringan"],
  ["Tanda tangani PKS", "monoton ringan"],
  ["Rekonsiliasi kas kecil", "monoton berat"],
  ["Koreksi ujian siswa", "monoton berat"],
  ["Transkrip rekaman wawancara", "monoton berat"],
  // Indonesian, affixed and informal
  ["Menyusun anggaran 2027", "aktif berat"],
  ["Menulis artikel blog", "aktif berat"],
  ["Menganalisis tren pasar", "aktif berat"],
  ["Mendesain banner promo", "aktif berat"],
  ["Merevisi slide pitch", "aktif berat"],
  ["Mempresentasikan progres", "aktif berat"],
  ["Memperbaiki bug login", "aktif berat"],
  ["Menghubungi vendor", "aktif ringan"],
  ["Diskusikan timeline dengan tim", "aktif ringan"],
  ["Membalas chat klien", "monoton ringan"],
  ["Mengirimkan dokumen ke legal", "monoton ringan"],
  ["Dikirim ke Bu Rina", "monoton ringan"],
  ["Mengecek kontrak", "monoton ringan"],
  ["Memeriksa laporan keuangan", "monoton ringan"],
  ["Menjadwalkan rapat", "monoton ringan"],
  ["Menyetujui cuti tim", "monoton ringan"],
  ["Ngecek email", "monoton ringan"],
];

describe("the lexicon", () => {
  it("has each word in one group only, lowercase, and finds every word by itself", () => {
    const all = Object.values(TASK_LEXICON).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const word of all) {
      expect(word).toBe(word.toLowerCase().trim());
      expect(findVerb(word)?.key).toBe(word);
    }
  });

  it.each(SAMPLES)("%s → %s", (title, expected) => {
    expect(rubricOf(title)).toBe(expected);
  });

  it("has at least 30 sample titles, in both languages", () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(30);
  });

  it("decides by the first known word, so a later noun does not count", () => {
    expect(findVerb("Siapkan bahan presentasi")?.key).toBe("siapkan");
    expect(findVerb("Email to Dina re: proposal draft")?.key).toBe("email");
    expect(findVerb("Finish writing the report")?.key).toBe("write"); // "finish" is not in the lexicon
  });
});

describe("unknown verbs", () => {
  it.each([
    ["Q3 budget", "budget"],
    ["Lunch with the team", "lunch"],
    ["Laporan bulanan", "laporan"],
    ["Makan siang bareng tim", "makan"],
    ["Kelas bahasa Inggris", "kelas"],
    ["Dina's birthday", "dina"],
    ["Selesaikan laporan", "selesaikan"],
  ])("%s → belum dinilai, asking about %s", (title, asked) => {
    const tag = tagTask(task("x", title), "2026-11-08", new Map(), new Map());
    expect(tag.sifat).toBe(NOT_ASSESSED);
    expect(tag.beban).toBe(NOT_ASSESSED);
    expect(tag.source).toBe("unknown");
    expect(tag.verb).toBe(asked);
  });

  it("matches whole words only, not a lexicon word hidden inside another", () => {
    for (const title of ["Task list", "Codebase notes", "Profile photo", "Planet fitness", "Callback number", "Payroll", "Cleanup day"]) {
      expect(findVerb(title), title).toBeNull();
    }
  });

  it("asks about nothing when the title has no word", () => {
    for (const title of ["", "🎉🎉", "2026", "[ProjectX]"]) {
      const tag = tagTask(task("x", title), "2026-11-08", new Map(), new Map());
      expect(tag.source).toBe("unknown");
      expect(tag.verb).toBeNull();
    }
  });

  it("does not trip over words that are names on Object.prototype", () => {
    for (const title of ["constructor", "__proto__ hasOwnProperty", "toString valueOf"]) {
      expect(findVerb(title)).toBeNull();
    }
  });
});

describe("robust to tags, emoji, punctuation and case", () => {
  it.each([
    ["[ProjectX] Write spec", "aktif berat"],
    ["[ACME][Q4] 🚀 Kirim invoice!!!", "monoton ringan"],
    ["URGENT: reply to Dina", "monoton ringan"],
    ["WRITE REPORT", "aktif berat"],
    ["#urgent @dina balas email", "monoton ringan"],
    ["Revisi—draf v2 (final)", "aktif berat"],
    ["…call Budi?!", "aktif ringan"],
    ["Re-check numbers", "monoton ringan"],
    ["{ops} 📞 Telepon klien", "aktif ringan"],
    ["Analýze résumé", "aktif berat"],
  ])("%s → %s", (title, expected) => {
    expect(rubricOf(title)).toBe(expected);
  });

  it("drops the bracketed tags, #tags and @mentions before reading the words", () => {
    expect(titleWords("[ProjectX] Write the e-mail to @budi #q4")).toEqual(["write", "the", "email", "to"]);
  });

  it("tries the word itself first, then English and Indonesian forms", () => {
    expect(stems("diskusi")[0]).toBe("diskusi");
    expect(stems("meeting")[0]).toBe("meeting");
    expect(stems("debugging")).toContain("debug");
    expect(stems("replied")).toContain("reply");
    expect(findVerb("Designing the signup page")?.key).toBe("design");
    expect(stems("menyusun")).toContain("susun");
    expect(stems("mengirim")).toContain("kirim");
    expect(stems("menulis")).toContain("tulis");
    expect(stems("memeriksa")).toContain("periksa");
  });
});

describe("tenggat", () => {
  it.each([
    ["2026-11-08", "2026-11-07", -1, "lewat"],
    ["2026-11-08", "2026-10-01", -38, "lewat"],
    ["2026-11-08", "2026-11-08", 0, "hari ini"],
    ["2026-11-08", "2026-11-09", 1, "besok"],
    ["2026-11-08", "2026-11-10", 2, "≤ 3 hari"],
    ["2026-11-08", "2026-11-11", 3, "≤ 3 hari"],
    ["2026-11-08", "2026-11-12", 4, "lainnya"],
    // month and year boundaries
    ["2026-10-31", "2026-11-01", 1, "besok"],
    ["2026-10-31", "2026-11-03", 3, "≤ 3 hari"],
    ["2026-12-31", "2027-01-01", 1, "besok"],
    ["2026-12-30", "2027-01-02", 3, "≤ 3 hari"],
    ["2027-01-01", "2026-12-31", -1, "lewat"],
    // leap years, and a weekend when Europe changes the clocks (29 Mar 2026)
    ["2028-02-28", "2028-03-01", 2, "≤ 3 hari"],
    ["2027-02-28", "2027-03-01", 1, "besok"],
    ["2026-03-28", "2026-03-30", 2, "≤ 3 hari"],
  ] as const)("today %s, due %s → %i days, %s", (today, due, days, bucket) => {
    expect(daysUntil(today, due)).toBe(days);
    expect(dueBucket(daysUntil(today, due))).toBe(bucket);
  });

  it("is null without a due date or with a date that does not exist", () => {
    expect(daysUntil("2026-11-08", null)).toBeNull();
    expect(dueBucket(null)).toBeNull();
    expect(daysUntil("2026-11-08", "2026-02-30")).toBeNull();
    expect(daysUntil("2026-11-08", "9/11/2026")).toBeNull();
    expect(daysUntil("garbage", "2026-11-09")).toBeNull();
  });

  it("goes into the tag with the position in Google Tasks", () => {
    const tag = tagTask(task("a", "Kirim invoice", { due: "2026-11-09", order: 4 }), "2026-11-08", new Map(), new Map());
    expect(tag).toMatchObject({ tenggat: "besok", hari_ke_tenggat: 1, urutan: 4, source: "lexicon", verb: "kirim" });
  });
});

describe("corrections and the personal dictionary", () => {
  const today = "2026-11-08";

  it("lets a correction override the lexicon for that task, and teaches the verb to the next task", () => {
    const invoices = task("a", "Review invoices");
    expect(rubricOf(invoices.title)).toBe("aktif berat");
    const memory = rememberTag(emptyTagMemory(), invoices, { sifat: "monoton", beban: "ringan" });
    expect(tagTask(invoices, today, memory.corrections, memory.personal)).toMatchObject({ sifat: "monoton", beban: "ringan", source: "correction" });
    // Another task with the same verb, in another form.
    const contracts = tagTask(task("b", "Reviewing vendor contracts"), today, memory.corrections, memory.personal);
    expect(contracts).toMatchObject({ sifat: "monoton", beban: "ringan", source: "personal", verb: "review" });
    // A task with another verb is untouched.
    expect(tagTask(task("c", "Write spec"), today, memory.corrections, memory.personal).source).toBe("lexicon");
  });

  it("asks an unknown verb once: the answer tags the next task with that word", () => {
    const lunch = task("a", "Lunch with Dina");
    const memory = rememberTag(emptyTagMemory(), lunch, { sifat: "aktif", beban: "ringan" });
    expect(memory.personal.get("lunch")).toEqual({ sifat: "aktif", beban: "ringan" });
    const next = tagTask(task("b", "[Team] Lunch & learn"), today, memory.corrections, memory.personal);
    expect(next).toMatchObject({ sifat: "aktif", beban: "ringan", source: "personal" });
  });

  it("keeps a task's own correction when its verb is later taught otherwise", () => {
    let memory = rememberTag(emptyTagMemory(), task("a", "Review invoices"), { sifat: "monoton", beban: "ringan" });
    memory = rememberTag(memory, task("b", "Review architecture"), { sifat: "aktif", beban: "berat" });
    expect(tagTask(task("a", "Review invoices"), today, memory.corrections, memory.personal).sifat).toBe("monoton");
    expect(tagTask(task("c", "Review budget"), today, memory.corrections, memory.personal).sifat).toBe("aktif");
  });

  it("never learns a stop word as a verb, so a later lexicon verb still decides (review B, 8 Nov)", () => {
    const routine: Rubric = { sifat: "monoton", beban: "ringan" };
    const quarterly = rememberTag(emptyTagMemory(), task("a", "The quarterly numbers"), routine);
    expect(quarterly.personal.has("the")).toBe(false);
    expect(quarterly.personal.get("quarterly")).toEqual(routine);
    for (const title of ["The budget review", "The client pitch deck"]) {
      expect(tagTask(task("b", title), today, quarterly.corrections, quarterly.personal), title).toMatchObject({
        sifat: "aktif",
        beban: "berat",
        source: "lexicon",
      });
    }
    const klien = rememberTag(emptyTagMemory(), task("c", "Untuk direksi"), routine);
    expect([...klien.personal.keys()]).toEqual(["direksi"]);
    expect(tagTask(task("d", "Untuk klien: rancang proposal"), today, klien.corrections, klien.personal)).toMatchObject({
      sifat: "aktif",
      verb: "rancang",
      source: "lexicon",
    });
    // Only stop words: the task keeps its answer, the dictionary learns nothing.
    const only = rememberTag(emptyTagMemory(), task("e", "Re: this"), routine);
    expect(only.corrections.get("e")).toEqual(routine);
    expect(only.personal.size).toBe(0);
    expect(tagTask(task("e", "Re: this"), today, only.corrections, only.personal)).toMatchObject({ source: "correction", verb: null });
    // No lexicon word is a stop word.
    expect(Object.values(TASK_LEXICON).flat().filter((w) => STOP_WORDS.has(w))).toEqual([]);
  });

  it("finds a learned Indonesian word through its affixes", () => {
    const memory = rememberTag(emptyTagMemory(), task("a", "Selesaikan laporan"), { sifat: "aktif", beban: "berat" });
    expect(findVerb("Menyelesaikan slide", memory.personal)).toMatchObject({ key: "selesaikan", source: "personal" });
  });

  it("does not change the memory it is given", () => {
    const before = emptyTagMemory();
    rememberTag(before, task("a", "Write spec"), { sifat: "aktif", beban: "berat" });
    expect(before.corrections.size).toBe(0);
    expect(before.personal.size).toBe(0);
  });

  it("keeps the most recent entries only", () => {
    let memory: TagMemory = emptyTagMemory();
    for (let i = 0; i <= TAG_MEMORY_LIMIT; i++) memory = rememberTag(memory, task(`id${i}`, "Write spec"), { sifat: "aktif", beban: "berat" });
    expect(memory.corrections.size).toBe(TAG_MEMORY_LIMIT);
    expect(memory.corrections.has("id0")).toBe(false);
    expect(memory.corrections.has(`id${TAG_MEMORY_LIMIT}`)).toBe(true);
  });
});

describe("persistence", () => {
  const fakeStorage = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  };

  it("round-trips through localStorage", () => {
    const storage = fakeStorage();
    const store = localTagStore(storage);
    let memory = rememberTag(emptyTagMemory(), task("a", "Lunch with Dina"), { sifat: "aktif", beban: "ringan" });
    memory = rememberTag(memory, task("b", "Write spec"), { sifat: "aktif", beban: "berat" });
    expect(store.save(memory)).toBe(true);
    expect(storage.data.has(TAG_MEMORY_KEY)).toBe(true);
    const loaded = localTagStore(storage).load();
    expect([...loaded.corrections]).toEqual([...memory.corrections]);
    expect([...loaded.personal]).toEqual([...memory.personal]);
  });

  it("survives garbage: whatever is not a valid entry is dropped", () => {
    for (const raw of ["not json", "null", "[]", "42", '"x"', '{"koreksi":"x","kamus":{}}', "{}"]) {
      const m = parseTagMemory(raw);
      expect(m.corrections.size + m.personal.size, raw).toBe(0);
    }
    const mixed = JSON.stringify({
      versi: 1,
      koreksi: [["a", "aktif", "berat"], ["b", "lazy", "berat"], ["", "aktif", "berat"], [7, "aktif", "berat"], "junk", ["c", "monoton"]],
      kamus: [["lunch", "aktif", "ringan"], ["x".repeat(61), "aktif", "ringan"], ["__proto__", "monoton", "ringan"]],
    });
    const m = parseTagMemory(mixed);
    expect([...m.corrections.keys()]).toEqual(["a"]);
    expect([...m.personal.keys()]).toEqual(["lunch", "__proto__"]);
    expect(({} as Record<string, unknown>).sifat).toBeUndefined(); // nothing leaked into Object.prototype
  });

  it("works without storage, and with storage that throws", () => {
    const memory = rememberTag(emptyTagMemory(), task("a", "Write spec"), { sifat: "aktif", beban: "berat" });
    expect(localTagStore(null).load().corrections.size).toBe(0);
    expect(localTagStore(null).save(memory)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(localTagStore(broken).load().personal.size).toBe(0);
    expect(localTagStore(broken).save(memory)).toBe(false);
    const blocked = { ...broken, removeItem: () => {
      throw new Error("blocked");
    } };
    expect(() => localTagStore(blocked).clear()).not.toThrow();
    expect(() => localTagStore(null).clear()).not.toThrow();
  });

  it("clear() removes the stored answers (Delete all history)", () => {
    const storage = fakeStorage();
    const store = localTagStore(storage);
    store.save(rememberTag(emptyTagMemory(), task("a", "Lunch with Dina"), { sifat: "aktif", beban: "ringan" }));
    store.clear();
    expect(storage.data.has(TAG_MEMORY_KEY)).toBe(false);
    expect(store.load().personal.size).toBe(0);
    const inMemory = memoryTagStore(rememberTag(emptyTagMemory(), task("a", "Write spec"), { sifat: "aktif", beban: "berat" }));
    inMemory.clear();
    expect(inMemory.load().corrections.size).toBe(0);
  });

  it("serializes to entries, never to the titles", () => {
    const memory = rememberTag(emptyTagMemory(), task("a", "Write the Zanzibar merger memo"), { sifat: "aktif", beban: "berat" });
    expect(serializeTagMemory(memory)).not.toMatch(/zanzibar|merger|memo/i);
  });

  it("has an in-memory store for tests and sessions without storage", () => {
    const store = memoryTagStore();
    const memory = rememberTag(emptyTagMemory(), task("a", "Write spec"), { sifat: "aktif", beban: "berat" });
    expect(store.save(memory)).toBe(true);
    expect(store.load()).toBe(memory);
  });
});

describe("toAbstractTasks: the only task data that may leave the laptop", () => {
  const SECRET = { title: "Zanzibar merger memo", list: "Board secrets", notes: "Gajah confidential", id: "MTIzZ29vZ2xlLWlk" };
  const tasks: ImportedTask[] = [
    task("g2", "Balas email Dina", { order: 7, due: "2026-11-07", listTitle: "Inbox" }),
    { ...task(SECRET.id, `Write ${SECRET.title}`, { order: 2, due: "2026-11-09", listTitle: SECRET.list }), notes: SECRET.notes } as ImportedTask,
    task("g3", "Lunch with the team", { order: 9 }),
  ];

  it("numbers the tasks t1..tn in Google Tasks order, positions without gaps", () => {
    const { tugas, peta } = toAbstractTasks(tasks, "2026-11-08", emptyTagMemory());
    expect(tugas).toEqual([
      { id: "t1", sifat: "aktif", beban: "berat", hari_ke_tenggat: 1, posisi: 0 },
      { id: "t2", sifat: "monoton", beban: "ringan", hari_ke_tenggat: -1, posisi: 1 },
      { id: "t3", sifat: NOT_ASSESSED, beban: NOT_ASSESSED, hari_ke_tenggat: null, posisi: 2 },
    ]);
    expect([...peta]).toEqual([
      ["t1", SECRET.id],
      ["t2", "g2"],
      ["t3", "g3"],
    ]);
  });

  it("carries exactly five fields per task", () => {
    const { tugas } = toAbstractTasks(tasks, "2026-11-08", emptyTagMemory());
    for (const t of tugas) expect(Object.keys(t).sort()).toEqual(["beban", "hari_ke_tenggat", "id", "posisi", "sifat"]);
  });

  it("leaks no title, list name, note or Google task id (with a control that the check sees them)", () => {
    const leaks = (json: string) => Object.values(SECRET).filter((s) => json.includes(s) || json.toLowerCase().includes(s.split(" ")[0].toLowerCase()));
    // Negative control: the same check finds every secret in the imported tasks.
    expect(leaks(JSON.stringify(tasks))).toEqual(Object.values(SECRET));
    const memory = rememberTag(emptyTagMemory(), tasks[2], { sifat: "aktif", beban: "ringan" });
    const { tugas } = toAbstractTasks(tasks, "2026-11-08", memory);
    expect(leaks(JSON.stringify(tugas))).toEqual([]);
    expect(JSON.stringify(tugas)).not.toMatch(/write|balas|lunch|inbox|work/i);
  });

  it("uses the user's corrections", () => {
    const memory = rememberTag(emptyTagMemory(), tasks[2], { sifat: "aktif", beban: "ringan" });
    const { tugas } = toAbstractTasks(tasks, "2026-11-08", memory);
    expect(tugas[2]).toMatchObject({ sifat: "aktif", beban: "ringan" });
  });

  it("asks nothing of an empty list", () => {
    expect(toAbstractTasks([], "2026-11-08", emptyTagMemory())).toEqual({ tugas: [], peta: new Map() });
    expect(askedWord("")).toBeNull();
  });
});
