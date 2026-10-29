import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/shared/defaults";
import {createProvider} from "../src/background/providers";
vi.mock("../src/background/providers",()=>({createProvider:vi.fn()}));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const settings={...DEFAULT_SETTINGS,cacheEnabled:false,concurrency:1};
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});
afterEach(()=>vi.unstubAllGlobals());
describe("video priority and cancellation through the shared translation service",()=>{
 it("removes a cancelled queued subtitle and never sends it to the provider",async()=>{
  let release!:(value:string[])=>void;
  const translate=vi.fn().mockImplementationOnce(()=>new Promise<string[]>(resolve=>{release=resolve;})).mockResolvedValue(["后续"]);
  vi.mocked(createProvider).mockReturnValue({id:"test",label:"test",validateConfig:()=>({ok:true}),translateBatch:translate});
  const {translateWithSettings}=await import("../src/background/translation");
  const first=translateWithSettings(settings,{texts:["first"],targetLang:"zh-CN"});await flush();
  const controller=new AbortController();
  const queued=translateWithSettings(settings,{texts:["cancel me"],targetLang:"zh-CN"},{signal:controller.signal,priority:true});
  const cancelled=expect(queued).rejects.toMatchObject({name:"AbortError"});await flush();controller.abort();await cancelled;
  const following=translateWithSettings(settings,{texts:["following"],targetLang:"zh-CN"});
  release(["第一"]);await first;await following;
  expect(translate.mock.calls.map(([request])=>request.texts[0])).toEqual(["first","following"]);
 });
 it("runs a queued live subtitle before queued page work without exceeding concurrency",async()=>{
  let release!:(value:string[])=>void;
  const translate=vi.fn().mockImplementationOnce(()=>new Promise<string[]>(resolve=>{release=resolve;})).mockImplementation(async request=>request.texts.map((text:string)=>"译:"+text));
  vi.mocked(createProvider).mockReturnValue({id:"test",label:"test",validateConfig:()=>({ok:true}),translateBatch:translate});
  const {translateWithSettings}=await import("../src/background/translation");
  const first=translateWithSettings(settings,{texts:["first"],targetLang:"zh-CN"});await flush();
  const page=translateWithSettings(settings,{texts:["page"],targetLang:"zh-CN"});await flush();
  const live=translateWithSettings(settings,{texts:["live"],targetLang:"zh-CN"},{priority:true});await flush();
  expect(translate).toHaveBeenCalledTimes(1);release(["第一"]);await Promise.all([first,page,live]);
  expect(translate.mock.calls.map(([request])=>request.texts[0])).toEqual(["first","live","page"]);
 });
});
