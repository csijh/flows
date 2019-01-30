import { read } from "./flows.mjs";

let component = read("a.txt");

async function go(request, response) {
    await component(request, response);
    console.log(response);
}

go({}, {});
