'use strict';

const { Device } = require('homey');

class CompletionBot extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    const retiredModels = ['gpt-3.5-turbo-instruct', 'davinci-002', 'babbage-002', 'babbage'];
    if (retiredModels.includes(this.getSetting('model'))) {
      this.log('Migrating retired CompletionBot model to gpt-6-luna');
      try {
        await this.setSettings({ model: 'gpt-6-luna' });
        this.log('CompletionBot model migration completed');
      } catch (error) {
        this.error('CompletionBot model migration failed:', error);
      }
    }
    this.log('CompletionBot has been initialized');
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('CompletionBot has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('CompletionBot settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('CompletionBot was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('CompletionBot has been deleted');
  }

}

module.exports = CompletionBot;
