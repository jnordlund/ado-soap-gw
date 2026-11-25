import { SaxesParser } from "saxes";

const soap11 = "http://schemas.xmlsoap.org/soap/envelope/";
const soap12 = "http://www.w3.org/2003/05/soap-envelope";
const notificationPath = "schemas.microsoft.com/TeamFoundation/2005/06/Services/Notification/03";
const namespaces = new Set(["http://" + notificationPath, "https://" + notificationPath]);

function parseXml(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root;
  let count = 0;
  parser.on("doctype", () => { throw new Error("Unsupported XML declaration"); });
  parser.on("opentag", ({ local, uri }) => {
    if (++count > 20000 || stack.length >= 64) throw new Error("XML exceeds limits");
    const node = { name: local, uri, children: [], text: "" };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const append = (value) => { if (stack.length) stack.at(-1).text += value; };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => stack.pop());
  parser.write(xml).close();
  return root;
}

function child(node, name) {
  return node.children.find(element => element.name === name);
}

function value(node, name) {
  return child(node, name)?.text.trim() || undefined;
}

function collectFields(node, fields) {
  const ref = value(node, "ReferenceName");
  if (ref) {
    const current = value(node, "NewValue") ?? value(node, "Value") ?? value(node, "OldValue");
    if (current) fields.set(ref.toLowerCase(), current);
  }
  for (const element of node.children) collectFields(element, fields);
}

export function parseNotification(xml) {
  const root = parseXml(xml);
  const body = child(root, "Body");
  const operation = body?.children[0];
  if (root.name !== "Envelope" || (root.uri !== soap11 && root.uri !== soap12) || body?.uri !== root.uri ||
      body.children.length !== 1 || operation.name !== "Notify" || !namespaces.has(operation.uri)) {
    throw new Error("Expected SOAP Notify");
  }
  const event = parseXml(value(operation, "eventXml"));
  const notification = { eventType: event.name, summary: value(event, "Summary") };
  if (/^WorkItem(?:Changed|Created)Event$/i.test(event.name)) {
    const fields = new Map();
    for (const section of ["CoreFields", "ChangedFields"]) {
      const node = child(event, section);
      if (node) collectFields(node, fields);
    }
    notification.id = fields.get("system.id") ?? value(event, "WorkItemId");
    notification.title = fields.get("system.title") ?? value(event, "WorkItemTitle") ?? value(event, "Title");
    const link = value(event, "DisplayUrl");
    if (link && URL.canParse(link) && ["https:", "http:"].includes(new URL(link).protocol)) {
      notification.url = link;
    }
  }
  return { namespace: operation.uri, envelope: root.uri, notification };
}

export function soapResponse({ namespace, envelope }, delivered) {
  const fault = envelope === soap12
    ? '<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text xml:lang="en">All channel attempts failed</s:Text></s:Reason></s:Fault>'
    : '<s:Fault><faultcode>s:Server</faultcode><faultstring>All channel attempts failed</faultstring></s:Fault>';
  const content = delivered
    ? '<NotifyResponse xmlns="' + namespace + '"/>'
    : fault;
  return new Response('<s:Envelope xmlns:s="' + envelope + '"><s:Body>' + content + '</s:Body></s:Envelope>', {
    status: delivered ? 200 : 500,
    headers: { "Content-Type": envelope === soap12 ? "application/soap+xml; charset=utf-8" : "text/xml; charset=utf-8" }
  });
}
