import flows from "./flows.mjs";

let request = { url: "//admin/././manage/../form.html?x=1&y=2" };
let response = {};

let go = flows.normalize("index.html");
go(request, response);

console.log("request =", request);
console.log("response =", response);
