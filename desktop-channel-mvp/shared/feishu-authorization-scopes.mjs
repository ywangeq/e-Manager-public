// Fixed read-only capabilities; user selection never supplies raw CLI arguments.
export const FEISHU_READ_PERMISSIONS = Object.freeze([
  { id: "calendar", label: "读取日程", scope: "calendar:calendar.event:read" },
  { id: "documents", label: "读取文档", scope: "docx:document:readonly" },
  { id: "meetings", label: "搜索会议", scope: "vc:meeting.search:read" },
  { id: "mail", label: "读取邮箱", scope: "mail:user_mailbox.message:readonly", scopes: Object.freeze(["mail:user_mailbox.message:readonly", "mail:user_mailbox.message.address:read", "mail:user_mailbox.message.subject:read", "mail:user_mailbox.message.body:read"]) },
  { id: "notes", label: "读取会议智能纪要", scope: "vc:note:read" },
]);
