import { assertEquals } from "jsr:@std/assert@1";
import {
  contactFromMessage,
  receiveSharedCapture,
} from "../js/crm-quick-capture.js";

Deno.test("capture extracts only reviewable contact channels and keeps email handles separate", () => {
  assertEquals(
    contactFromMessage(
      "Email hello@example.test or text +1 (214) 555-0100. Instagram @example_studio",
    ),
    {
      client_email: "hello@example.test",
      client_phone: "+1 (214) 555-0100",
      instagram: "example_studio",
    },
  );
  assertEquals(contactFromMessage("A shoot at 3:30 on Friday"), {
    client_email: "",
    client_phone: "",
    instagram: "",
  });
  assertEquals(contactFromMessage("hello@example.test"), {
    client_email: "hello@example.test",
    client_phone: "",
    instagram: "",
  });
});

Deno.test("shared lead text is removed from the address and retained for authenticated capture", () => {
  const saved = new Map();
  let address;
  const active = receiveSharedCapture(
    {
      href:
        "https://example.test/crm/?share_text=Private+request&share_title=Inquiry&view=today",
    },
    {
      replaceState(_state, _title, path) {
        address = path;
      },
    },
    {
      setItem(key, value) {
        saved.set(key, value);
      },
    },
  );
  assertEquals(active, true);
  assertEquals(saved.get("crm-shared-capture"), "Inquiry\nPrivate request");
  assertEquals(address, "/crm/?view=today&capture=1");
});
