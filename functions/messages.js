const functions = require('firebase-functions');
const { getVolunteerSlackID } = require('./airtable');

const CHANNEL_IDS = functions.config().slack.channel_to_id;
const STATUS_TO_EMOJI = {
  'Seeking Volunteer': ':exclamation:',
  'Assigned / In Progress': ':woman-biking:',
  'Complete': ':white_check_mark:',
};

const safetyReminder = 'Reminder: Please don’t volunteer for delivery if you have any COVID-19/cold/flu-like symptoms, or have come into contact with someone that’s tested positive.';

/**
 * Get intake post content for a request's status
 */
// TODO : add household size
async function getIntakePostContent(fields) {
  const intakeVolunteerSlackID = await getVolunteerSlackID(fields.intakeVolunteer);

  if (!intakeVolunteerSlackID) {
    console.error('Missing Intake Volunteer Slack ID', {
      ticket: fields.ticketID,
      volunteer: fields.intakeVolunteer,
    });
  }

  let content = `<@${intakeVolunteerSlackID}> got a new volunteer request from our neighbor ${fields.requestName}

*Status:* ${STATUS_TO_EMOJI[fields.status]} ${fields.status}\n`;

  if (fields.status !== 'Seeking Volunteer') {
    content += '*Assigned to*: ';

    const deliveryVolunteerslackID = await getVolunteerSlackID(fields.deliveryVolunteer);
    if (deliveryVolunteerslackID) {
      content += `<@${deliveryVolunteerslackID}>`;
    } else {
      content += ':question:';
    }
  }

  // Divides the status form the other info
  content += '\n'

  content += `
*Ticket ID*: ${fields.ticketID}
*Timeline*: ${fields.timeline}
*Cross Streets*: ${fields.crossStreets}
*Need*: ${fields.category}
*Household Size*: ${fields.householdSize || ':question:'}

*Want to help ${fields.requestName}?* Comment on this thread and an intake volunteer will follow up with more details. :point_down:
`;

  return content;
}


/**
 * Get details to post in intake post's thread
 */
async function getIntakePostDetails(fields) {
  return `
*Description*: ${fields.description}
*Language*: ${fields.language}

*Requested*: ${fields.items}
`;
}

/**
 * Get detailed message for delivery volunteers
 */
async function getDeliveryDMContent(fields) {
  const intakeVolunteerslackID = await getVolunteerSlackID(fields.intakeVolunteer);

  // TODO : gear the reimbursement flow towards delivery completion
  // TODO : error handling if volunteer id isn't present
  // TODO : don't send the volunteer this monstrosity of a message every time they take a delivery

  let content = `
<@${intakeVolunteerslackID}> assigned a request to you. Thanks so much for taking care of this delivery!

*Ticket ID*: ${fields.ticketID}

*Neighbor*: ${fields.requestName}
*Address*: ${fields.address}
*Delivery Notes*: ${fields.deliveryNotes || '_empty_'}
*Phone*: ${fields.phoneNumber}
*Timeline*: ${fields.timeline}
*Language*: ${fields.language}
*Special Conditions*: ${fields.vulnerability}

*Need*: ${fields.category}
*Description*: ${fields.description}
*Household Size*: ${fields.householdSize || '?'}
*Requested*: ${fields.items}\n`;

  // TODO : this is messy
  if (fields.householdSize) {
    content += '*Spending guidance:*\n';
    const householdSize = parseInt(fields.householdSize);

    if (householdSize <= 2) {
      content += '- $75/per person (1-2 ppl)\n';
    } else if (householdSize <= 5) {
      content += '- $250 for a medium household (3-5 ppl)\n';
    } else {
      content += '- $350 for a large household (6+ ppl)\n';
    }

    // NOTE that we want the next next message to be a bullet only if we have a "Spending Guidance section"
    content += '- ';
  }

  content += 'Please try to buy about a week’s worth of food for the household. It’s ok if you can’t get every single thing on the shopping list--the main goal is that the family’s nutritional needs are sufficiently met.\n';

  content += `
*When you complete the delivery, please:*
- Take a photo of the receipt
- Fill out <https://airtable.com/shrvHf4k5lRo0I8F4|this completion form> to let us know that the delivery is completed. If you need reimbursement please fill out the reimbursement section, and you will be reimbursed from our community fund within 24 hours.
- For guidance on how to do a no-contact delivery, check out our <https://docs.google.com/document/d/1-sXwubRG3yBw2URDYcrSGZSj94tY_Ydk4xxVDmgRFh8/edit?usp=sharing|Delivery Volunteer FAQ guide>.

If you have any questions/problems, please post in <#${CHANNEL_IDS.delivery_volunteers}>. Thanks again for volunteering!

_${safetyReminder}_

:heart: :heart: :heart:`;

  return content;
}

module.exports = {
  getIntakePostContent,
  getDeliveryDMContent,
  getIntakePostDetails,
};