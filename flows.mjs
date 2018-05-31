import fs from "fs/promises";

export default { chain, choose, normalize, read, write, type, deliver, log };

// Combine components into a sequence.
export function chain() {
    let args = arguments;
    async function chainC(request, response) {
        for (let i in args) {
            await args[i](request, response);
        }
    }
    return chainC;
}

// Decide between components.
export function choose() {
    let args = arguments;
    if (args.length < 2) throw "choose needs at least two arguments";
    async function chooseC(request, response) {
        while (args.length >= 2) {
            let pattern = args[0];
            let component = args[1];
            Array.prototype.shift.call(args);
            Array.prototype.shift.call(args);
            if (! match(pattern, request)) continue;
            await component(request, response);
            return;
        }
        if (args.length == 1) await args[0](request, response);
    }
    return chooseC;
}

// The three common and six uncommon request methods.
const methods = [
    "GET", "POST", "PUT",
    "HEAD", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"
];

// Check request against pattern.
function match(pattern, request) {
    if (typeof pattern != "string") throw "Error: expecting string";
    let parts = pattern.split(' ');
    if (parts.length > 2) throw "Error: space in URL pattern";
    if (parts.length == 2) {
        let m = parts[0].toUpperCase();
        if (methods.indexOf(m) < 0) {
            throw "Error: method pattern should be GET, POST or PUT";
        }
        if (request.method != m) return false;
        pattern = parts[1];
    }
    parts = pattern.split('*');
    if (parts.length != 2) throw "Error: URL pattern needs a single '*'";
    if (request.url.startsWith(parts[0]) && request.url.endsWith(parts[1])) {
        let start = parts[0].length, end = request.url.length - parts[1].length;
        request.suburl = request.url.substring(start, end);
        return true;
    }
    return false;
}

// Given the name of the default index file for a directory, e.g. "index.html",
// normalize the url so that it becomes suitable for use as a file path, and
// validate it against security attacks. Transfer any parameters to a
// request.parameters object. Replace "//" and "/./" and "/xxx/../" by "/" being
// careful to handle "/././" for example, which a global replace would miss.
// Report a validation error for a url which is longer than 250 characters,
// because of maximum path lengths etc. Report a validation error if the url
// does not start with '/' or if it still contains '/../' which indicates an
// attempt to access files outside the site or if it contains '/.' which is an
// attempt to access a file or directory that starts with a dot, which is almost
// certainly supposed to be hidden. Note that triples such as "%20" and other
// possible codes are not replaced, so they must be translated if desired before
// using the url as a file path.
export function normalize(index) {
    function normComponent(request, response) {
        if (request.url == undefined) return;
        parameters(request);
        let u = request.url;
        let go = true;
        let dots = /\/[^/]*\/\.\.\//;
        while (go) {
            go = false;
            if (u.indexOf("/./") >= 0) { go = true; u = u.replace("/./", "/"); }
            if (u.indexOf("//") >= 0) { go = true; u = u.replace("//", "/"); }
            if (u.search(dots) >= 0) { go = true; u = u.replace(dots, "/"); }
        }
        if (u.endsWith("/")) u = u + index;
        let m = undefined;
        if (u.length > 250) m = "Url too long";
        else if (u.length == 0 || u[0] != '/') m = "Url doesn't start with '/'";
        else if (u.indexOf("/../") >= 0) m = "Url goes outside of the site";
        else if (u.indexOf("/.") >= 0) m = "Url refers to a hidden files";
        if (m != undefined) {
            response.status = 400;
            response.message = m;
        }
        request.url = u;
    }
    return normComponent;
}


// Transfer any url parameters to a request.parameters field.
function parameters(request) {
    if (request.url.indexOf('?') < 0) return;
    let parts = request.url.split("?");
    request.url = parts[0];
    let params = parts[1];
    parts = params.split("&");
    request.parameters = {};
    for (let i in parts) {
        let def = parts[i];
        let pair = def.split("=", 2);
        request.parameters[pair[0]] = pair[1];
    }
}

// Read a given file, appending the content onto response.data, or set
// response.status to 404. If called with one argument, create a component.
export function read(name) {
    async function readComponent(request, response) {
        if (response.status != undefined && response.status != 200) return;
        let file = name;
        if (file.indexOf('{') >= 0) file = replaceField(file, request);
        try {
            response.status = 200;
            let content = await fs.readFile(file);
            if (response.data == undefined) response.data = content;
            else response.data += content;
        }
        catch (err) {
            response.status = 404;
            response.message = "Can't read file " + file;
        }
    }
    return readComponent;
}

// Given a filename such as "/files{url}" replace "{url}" by response.url.
function replaceField(file, request) {
    let open = file.indexOf('{'), close = file.indexOf('}');
    if (open < 0 || close < open) return file;
    let field = file.slice(open+1, close);
    return file.slice(0, open) + request[field] + file.slice(close+1);
}

// Write a given file, with the content popped from response.data, or set
// response.status to 500. If called with one argument, create a component.
export function write(name) {
    async function writeComponent(request, response) {
        if (response.status != undefined && response.status != 200) return;
        if (response.data == undefined) return;
        let file = name;
        if (file.indexOf('{') >= 0) file = replaceField(file, request);
        try { await fs.writeFile(file, response.data); }
        catch (err) {
            response.status = 500;
            response.message = "Can't write file " + file;
        }
    }
    return writeComponent;
}

// Find the content type of the response from the given map and the extension of
// the URL and attach it as a field response.type, if it hasn't already been
// set. The map must be an object with a getType method, e.g. from the mime/lite
// module. If a status code other than 200 has been set, make response.message
// into a plain text result. If the type for HTML is "application/xhtml+xml"
// then content negotiation is used to determine whether the browser accepts
// that type, otherwise "text/html" is used instead.
export function type(map) {
    async function typeComponent(request, response) {
        if (response.type != undefined) return;
        if (response.status != undefined && response.status != 200) {
            response.data = response.message;
            response.type = "text/plain";
        }
        else {
            let dot = request.url.lastIndexOf('.');
            if (dot < 0) return;
            let ext = request.url.substring(dot + 1);
            response.type = map.getType(ext);
            if (ext == "html" && response.type == "application/xhtml+xml") {
                if (request.headers != undefined) return;
                let accept = request.headers.accept;
                if (accept == undefined) return;
                if (accept.indexof("application/xhtml+xml") >= 0) return;
                response.type = "text/html";
            }
        }
    }
    return typeComponent;
}

// Deliver the response, assuming that response,data and response.type and
// response.status have been set.
export function deliver(request, response) {
    let hdr = { "Content-Type": response.type };
    response.writeHead(response.status, hdr);
    response.write(response.data);
    response.end();
}

// Print out the interesting parts of the request and response objects, leaving
// out the mess, and allowing for simplified objects used in testing.
export function log(request, response) {
    let r = {};
    if (request.method != undefined) r.method = request.method;
    if (request.url != undefined) r.url = request.url;
    if (request.parameters != undefined) r.parameters = request.parameters;
    if (request.headers != undefined) r.headers = request.headers;
    console.log("request =", r);
    r = {};
    if (response.data != undefined) r.data = response.data;
    if (response.type != undefined) r.type = response.type;
    if (response.status != undefined) r.status = response.status;
    if (response.message != undefined) r.message = response.message;
    console.log("response =", r);
}
