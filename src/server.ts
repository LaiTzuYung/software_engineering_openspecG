import { createLiveBuzzerServer } from "./live-buzzer/http-server.ts";

const app = createLiveBuzzerServer();
const baseUrl = await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1");
console.log(`老師頁：${baseUrl}/teacher-login`);
console.log(`學生頁：${baseUrl}/student`);
console.log(`大螢幕頁：${baseUrl}/screen`);
console.log(`老師 PIN：${app.teacherPin}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
