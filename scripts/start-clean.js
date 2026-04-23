const { execSync } = require("child_process");
const path = require("path");

const rawPort = process.env.PORT || "9090";
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port <= 0) {
  console.error(`PORT invalida: ${rawPort}`);
  process.exit(1);
}

function listPidsOnPort(targetPort) {
  try {
    const output = execSync(`lsof -ti tcp:${targetPort}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    if (!output) {
      return [];
    }

    return output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value));
  } catch {
    return [];
  }
}

function sendSignalToPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      console.warn(`Nao foi possivel enviar ${signal} para PID ${pid}: ${error.message}`);
    }
  }
}

function killPortProcesses(targetPort) {
  const pids = listPidsOnPort(targetPort).filter((pid) => pid !== process.pid);

  if (pids.length === 0) {
    console.log(`Porta ${targetPort} ja esta livre.`);
    return;
  }

  console.log(`Liberando porta ${targetPort}. Encerrando PID(s): ${pids.join(", ")}`);

  sendSignalToPids(pids, "SIGTERM");

  let lingering = listPidsOnPort(targetPort).filter((pid) => pid !== process.pid);
  if (lingering.length > 0) {
    console.log(`PID(s) ainda ativos na porta ${targetPort}. Forcando encerramento: ${lingering.join(", ")}`);
    sendSignalToPids(lingering, "SIGKILL");
    lingering = listPidsOnPort(targetPort).filter((pid) => pid !== process.pid);
  }

  if (lingering.length > 0) {
    console.error(`A porta ${targetPort} ainda esta em uso pelos PID(s): ${lingering.join(", ")}`);
    process.exit(1);
  }

  console.log(`Porta ${targetPort} liberada com sucesso.`);
}

killPortProcesses(port);
console.log(`Iniciando servidor na porta ${port}...`);
process.env.PORT = String(port);
require(path.join(__dirname, "..", "server.js"));
