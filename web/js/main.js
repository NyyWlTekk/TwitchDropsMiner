// MAIN PAGE

function addConsoleLine(message) {
    addConsoleLineRaw(message);
}

function addConsoleLineRaw(line) {
    const console = document.getElementById('console-output');
    if (!console) return;

    const div = document.createElement('div');
    div.textContent = line;
    console.appendChild(div);
    console.scrollTop = console.scrollHeight;

    while (console.children.length > 1000) {
        console.removeChild(console.firstChild);
    }
}
