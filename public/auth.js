// Shared logic for login.html and signup.html
(() => {
  const form = document.getElementById("auth-form");
  const errorBox = document.getElementById("auth-error");
  const mode = form.dataset.mode;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const { username, password, confirm } = Object.fromEntries(new FormData(form));

    if (!username.trim() || !password) return showError("יש למלא שם משתמש וסיסמה");
    if (mode === "signup" && password !== confirm) return showError("הסיסמאות אינן תואמות");

    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const res = await fetch(`/api/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "הפעולה נכשלה");
      location.href = "/";
    } catch (err) {
      showError(err.message === "Failed to fetch" ? "אין חיבור לשרת" : err.message);
      button.disabled = false;
    }
  });
})();
