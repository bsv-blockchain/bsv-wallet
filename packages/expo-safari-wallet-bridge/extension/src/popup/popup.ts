// Status only (Task 14 onward adds onboarding copy). Walking skeleton: shows that the background answers.
const status = document.getElementById('status')

browser.runtime.sendMessage({ type: 'ping' }).then(
  (reply: any) => {
    if (status) status.textContent = reply && reply.pong ? `${reply.name} is on` : 'No answer'
  },
  () => {
    if (status) status.textContent = 'No answer'
  }
)
