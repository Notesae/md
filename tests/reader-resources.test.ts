// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "../src/reader";
import type { ReaderDocument } from "../src/types";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
const BaseURL = URL;
let reader: Reader;
let article: HTMLElement;
let observer: TestObserver;
let workerFault: "construct" | "post" | null;
let urlSequence = 0;
const liveUrls = new Set<string>();
const workers: TestWorker[] = [];
const createUrl = vi.fn(); const revokeUrl = vi.fn();

/** 用真实观察器回调驱动可见性，资源和 Worker 的结果由每例精确控制。 */
class TestObserver {
  constructor(readonly callback: IntersectionObserverCallback) { observer = this; }
  observe() {} unobserve() {} disconnect() {}
}
class TestWorker {
  onmessage: ((event: MessageEvent<{ id: number; html: string | null }>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn(() => { if (workerFault === "post") throw new Error("投递失败"); });
  constructor() { if (workerFault === "construct") throw new Error("启动失败"); workers.push(this); }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const visible = (target: Element, isIntersecting = true) => observer.callback([{ target, isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
const slot = () => article.querySelector<HTMLElement>(".image-slot")!;
const failedImage = () => slot().querySelector("img")!.dispatchEvent(new Event("error"));
const retry = () => slot().querySelector<HTMLButtonElement>(".image-retry")!;
const value = (remote = false, revision = 1): ReaderDocument => ({
  path: "合成资源.md", title: "合成资源", bytes: 100, revision, readMs: 0, parseMs: 0, cacheMs: 0, cacheHit: false, cacheError: null,
  blocks: ['<div class="image-slot" data-image="0">示意图</div><pre><code class="language-js">const value = 1;</code></pre><span class="math">x^2</span>'],
  blockHashes: [], headings: [], images: [{ url: remote ? "https://example.invalid/image.png" : "image.png", remote }], links: [],
});
const show = async (remote = false, revision = 1) => reader.show(value(remote, revision), () => {});

beforeEach(async () => {
  vi.clearAllMocks(); native.invoke.mockReset(); liveUrls.clear(); workers.length = 0; workerFault = null; urlSequence = 0;
  document.body.innerHTML = '<main tabindex="0"><article></article></main>'; article = document.querySelector("article")!;
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("IntersectionObserver", TestObserver); vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  createUrl.mockImplementation(() => { const url = `blob:synthetic-${++urlSequence}`; liveUrls.add(url); return url; });
  revokeUrl.mockImplementation((url: string) => liveUrls.delete(url));
  vi.stubGlobal("URL", class extends BaseURL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
  native.invoke.mockResolvedValue(new ArrayBuffer(3));
  reader = new Reader(article, document.querySelector("main")!); reader.onMessage = vi.fn(); await show();
});
afterEach(() => { reader.dispose(); vi.unstubAllGlobals(); });

describe("图片失败恢复与 URL 生命周期", () => {
  it("解码失败立即释放 URL，保留可访问的说明和重试，点击后重新读取", async () => {
    visible(slot()); await settle(); expect(liveUrls.size).toBe(1); failedImage();
    expect(liveUrls.size).toBe(0); expect(Reflect.get(reader, "blobs").size).toBe(0);
    expect(slot().querySelector('[role="status"]')?.textContent).toContain("图片加载失败");
    expect(retry().getAttribute("aria-label")).toContain("示意图");
    retry().click(); await settle(); expect(native.invoke).toHaveBeenCalledTimes(2); expect(slot().querySelector("img")).not.toBeNull();
  });

  it("读取失败可以重试，错误作为文本呈现，连续点击只发出一次读取", async () => {
    native.invoke.mockRejectedValueOnce(new Error('<img src=x onerror="alert(1)">'));
    visible(slot()); await settle(); expect(slot().querySelector("img")).toBeNull(); expect(slot().textContent).toContain("<img");
    let resolve!: (value: ArrayBuffer) => void; native.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    retry().click(); retry().click(); expect(retry().disabled).toBe(true); expect(native.invoke).toHaveBeenCalledTimes(2);
    resolve(new ArrayBuffer(3)); await settle(); expect(slot().querySelector("img")).not.toBeNull();
  });

  it("远程图片及失败重试都必须显式点击，滚动不会发起远程加载", async () => {
    await show(true); visible(slot()); await settle(); expect(slot().querySelector("img")).toBeNull();
    slot().querySelector<HTMLButtonElement>(".load-remote")!.click(); await settle(); failedImage();
    visible(slot(), false); visible(slot()); await settle(); expect(slot().querySelector("img")).toBeNull();
    retry().click(); await settle(); expect(slot().querySelector("img")?.src).toBe("https://example.invalid/image.png");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("不安全远程地址重试仍被拒绝，不创建图片或调用原生读取", async () => {
    const document = value(true); document.images[0].url = "http://example.invalid/image.png"; await reader.show(document, () => {});
    slot().querySelector<HTMLButtonElement>(".load-remote")!.click(); await settle();
    expect(slot().querySelector("img")).toBeNull(); expect(slot().textContent).toContain("HTTPS"); expect(native.invoke).not.toHaveBeenCalled();
  });

  it("旧图片迟到的错误不能替换重试后加载的新图片或释放新 URL", async () => {
    visible(slot()); await settle(); const old = slot().querySelector("img")!; failedImage(); retry().click(); await settle();
    const latest = slot().querySelector("img"); old.dispatchEvent(new Event("error"));
    expect(slot().querySelector("img")).toBe(latest); expect(liveUrls.size).toBe(1);
  });

  it("切换后迟到的本地读取不创建 URL，离屏和关闭各只释放持有的 URL", async () => {
    let resolve!: (value: ArrayBuffer) => void; native.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    visible(slot()); await show(false, 2); resolve(new ArrayBuffer(3)); await settle(); expect(createUrl).not.toHaveBeenCalled();
    visible(slot()); await settle(); visible(slot(), false); expect(liveUrls.size).toBe(0); expect(revokeUrl).toHaveBeenCalledTimes(1);
    visible(slot()); await settle(); reader.dispose(); expect(liveUrls.size).toBe(0); expect(revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("键盘重试在图片恢复和再次失败时保留焦点", async () => {
    visible(slot()); await settle(); failedImage(); retry().focus(); retry().click(); await settle();
    expect(document.activeElement).toBe(slot().querySelector("img"));
    failedImage(); expect(document.activeElement).toBe(retry());
    native.invoke.mockRejectedValueOnce(new Error("仍不可读")); retry().click(); await settle(); expect(document.activeElement).toBe(retry());
  });

  it("重试等待期间用户转到其他控件，成功或失败都不能抢回焦点", async () => {
    visible(slot()); await settle(); failedImage();
    const other = document.createElement("input"); document.body.append(other);
    let resolve!: (value: ArrayBuffer) => void; native.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    retry().focus(); retry().click(); other.focus(); resolve(new ArrayBuffer(3)); await settle(); expect(document.activeElement).toBe(other);
    failedImage(); expect(document.activeElement).toBe(other);
  });

  it("离屏回收已获焦点的图片时，把焦点交回阅读区以继续键盘滚动", async () => {
    visible(slot()); await settle(); failedImage(); retry().focus(); retry().click(); await settle();
    expect(document.activeElement).toBe(slot().querySelector("img"));
    visible(slot(), false); expect(document.activeElement).toBe(article.parentElement); expect(liveUrls.size).toBe(0);
  });
});

describe("增强 Worker 故障与有界队列", () => {
  it("Worker 报错终止线程并清空待处理队列，本篇保留原文且不重复创建失败线程", () => {
    const code = article.querySelector("code")!; const math = article.querySelector(".math")!;
    visible(code); visible(math); expect(Reflect.get(reader, "jobs").size).toBe(2);
    workers[0].onerror!(); expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(Reflect.get(reader, "jobs").size).toBe(0);
    visible(code); visible(math); expect(workers).toHaveLength(1); expect(reader.onMessage).toHaveBeenCalledOnce();
    expect(code.textContent).toBe("const value = 1;"); expect(math.textContent).toBe("x^2");
  });

  it.each(["construct", "post"] as const)("Worker %s 失败降级到原文，清空任务并报告一次", fault => {
    workerFault = fault; const code = article.querySelector("code")!;
    expect(() => visible(code)).not.toThrow(); expect(Reflect.get(reader, "jobs").size).toBe(0);
    expect(reader.onMessage).toHaveBeenCalledOnce(); expect(code.textContent).toContain("const value");
  });

  it("换文后恢复增强，旧 Worker 的迟到错误不能终止新线程", async () => {
    visible(article.querySelector("code")!); const oldError = workers[0].onerror!;
    workers[0].onerror!(); await show(false, 2); visible(article.querySelector("code")!);
    expect(workers).toHaveLength(2); oldError(); expect(workers[1].terminate).not.toHaveBeenCalled(); expect(reader.onMessage).toHaveBeenCalledOnce();
    expect(Reflect.get(reader, "jobs").size).toBe(1);
    const id = Reflect.get(reader, "jobId"); workers[1].onmessage!({ data: { id, html: '<span class="hljs-keyword">const</span> value = 1;' } } as MessageEvent);
    expect(article.querySelector(".hljs-keyword")?.textContent).toBe("const"); expect(Reflect.get(reader, "jobs").size).toBe(0);
  });

  it("100 次合成换文和故障后 URL、Worker、队列及文档元数据均无遗留", async () => {
    for (let i = 0; i < 100; i++) {
      await show(false, i + 2); visible(slot()); await settle(); failedImage();
      expect(liveUrls.size).toBe(0);
      visible(article.querySelector("code")!); workers.at(-1)!.onerror!(); expect(Reflect.get(reader, "jobs").size).toBe(0); reader.dispose();
      expect(liveUrls.size).toBe(0); expect(Reflect.get(reader, "jobs").size).toBe(0); expect(Reflect.get(reader, "current")).toBeNull();
    }
    expect(createUrl).toHaveBeenCalledTimes(100); expect(revokeUrl).toHaveBeenCalledTimes(100);
    expect(workers).toHaveLength(100); expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    console.info('synthetic-resource-lifecycle', JSON.stringify({cycles:100,createdUrls:createUrl.mock.calls.length,revokedUrls:revokeUrl.mock.calls.length,workers:workers.length,terminated:workers.filter(worker=>worker.terminate.mock.calls.length===1).length,retainedUrls:liveUrls.size,pendingJobs:Reflect.get(reader,"jobs").size}));
  });
});
