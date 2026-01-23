const https = require('https');
const url = 'https://weatherlink-monitor.mashhood2717.workers.dev/api/stations-with-uptime';

https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const json = JSON.parse(data);
        const stations = json.stations;

        function determineProvince(location) {
            if (!location) return '';
            
            const loc = location.toLowerCase();
            
            // Islamabad - check first as it's specific
            if (loc.includes('islamabad') || loc.includes('i-8') || loc.includes('i-9') || loc.includes('i-10') || loc.includes('f-8') || loc.includes('g-8') || loc.includes('g-15') || loc.includes('d-12') || loc.includes('d-17') || loc.includes('kulsoom international') || loc.includes('diamond cricket ground') || loc.includes('farash town') || loc.includes('block e') || loc.includes('banigala') || loc.includes('quaid e azam university') || loc.includes('kachnar park') || loc.includes('bharakahu') || loc.includes('sihala')) return 'Islamabad';
            
            // Punjab cities - comprehensive list
            const punjabCities = [
                'lahore', 'rawalpindi', 'rwp', 'pindi', 'multan', 'faisalabad', 'gujranwala', 'sialkot', 'bahawalpur', 'sargodha', 'sheikhupura', 'jhang', 'rahim yar khan', 'kasur', 'chiniot', 'kamoke', 'hafizabad', 'mianwali', 'attock', 'mailsi', 'chak', 'kallar kahar', 'chakri', 'bhalwal', 'jhelum', 'gujjar khan', 'pindi gheb', 'jalalpur jattan', 'ferozewala', 'burewala', 'hasilpur', 'gulgasht', 'mitha tiwana', 'nammal', 'malian kalan', 'gattar', 'chitti shiekhan', 'kot agha jajjah', 'balkasar', 'neela dulha', 'bhera', 'lillah', 'salam', 'ravi', 'khanqa dograh', 'pindi bhattian', 'pia housing society', 'gulraiz car chowk', 'askari-14', 'sir gojra mohala', 'muslim colony', 'namal university', 'model town hasilpur', 'islamia university bahawalpur', 'karore village', 'wahali zer', 'barrier 3', 'kot momin', 'khanewal', 'vehari', 'lodhran', 'okara', 'pakpattan', 'sahiwal', 'toba tek singh', 'nankana', 'layyah', 'bhakkar', 'khushab', 'chakwal', 'jhelum', 'gujrat', 'mandi bahauddin', 'narowal', 'rajanpur', 'dera ghazi khan', 'muzaffargarh',
                // Additional specific locations from unknown list
                'punjab university', 'daud khel', 'bestway cement', 'stud farm depalpur', 'khan bela', 'zahir pir', 'comsats university', 'kharian', 'januwala', 'cholistan', 'sadhoke', 'arfu chapu', 'sohdra wazirabad', 'kot sanduki burhan', 'renala khurd', 'nawan khoo', 'kahror pakka', 'qasuri farms', 'jhoke fazal', 'kamalia', 'aminabad', 'gojra', 'peerowal', 'ahmedpur east', 'chichawatni', 'ghagoki', 'phalia', 'kuthiala', 'malakwal', 'murree', 'terrace grill', 'taunsa', 'kakriwali', 'jallowali', 'garha more', 'khanpur bagga sher', 'shergarh', 'pansera', 'choa saidan shah', 'kot pindi das', 'sial mor', 'haroonabad', 'harappa', 'dhurnal', 'manga mandi', 'hiran minar', 'bassali', 'westridge', 'kot rada kishan', 'bilal farms', 'khanpur', 'kot gullah', 'jaranwala', 'pasrur', 'ramkey', 'kallar sayedan', 'rawat', 'kusak', 'kirpa', 'rri', 'kala shah kaku', 'pir mahal', 'liaqatpur', 'jalalpur peerwala', 'khui ratta', 'dg khan', 'kot addu', 'kot qaisrani', 'muhammad pur dewan'
            ];
            if (punjabCities.some(city => loc.includes(city))) return 'Punjab';
            
            // KPK cities - comprehensive list  
            const kpkCities = [
                'peshawar', 'abbottabad', 'mardan', 'swat', 'kohat', 'bannu', 'd.i khan', 'dera ismail khan', 'charsadda', 'nowshera', 'swabi', 'haripur', 'mansehra', 'batkhela', 'tangi', 'topi', 'takht bhai', 'garhi mali khel', 'rustam', 'kalabagh', 'haji abad', 'lower dir', 'upper dir', 'buner', 'shangla', 'chitral', 'karak', 'hangu', 'lakki marwat', 'tank', 'dera ghazi khan',
                // Additional specific locations from unknown list
                'nathiagali', 'qubed', 'tareen kor', 'shahrag', 'mingora', 'barikot', 'balakot', 'battal', 'bampokha', 'paharpur', 'latamber', 'ouch', 'shahbaz garhi', 'dandao', 'takhtbai', 'waziristan', 'zarmilana'
            ];
            if (kpkCities.some(city => loc.includes(city))) return 'KPK';
            
            // Sindh cities - comprehensive list
            const sindhCities = [
                'karachi', 'hyderabad', 'sukkur', 'larkana', 'nawabshah', 'mirpur khas', 'jacobabad', 'shikarpur', 'dadu', 'thatta', 'badin', 'khairpur', 'sanghar', 'umerkot', 'tharparkar', 'gulshan-e-hadeed', 'pib colony', 'sujrani town', 'surjani', 'jamshoro', 'matiari', 'tando allahyar', 'tando adam', 'tando muhammad khan', 'ghotki', 'kashmore', 'qambar', 'shahdadkot', 'naushahro feroze', 'benazirabad',
                // Additional specific locations from unknown list
                'johi', 'moro', 'daro', 'sujawal', 'daharki', 'garhi yaseen', 'khoski', 'samaro', 'naseerabad', 'dera allah yar', 'jaffarabad', 'dolmen city', 'scheme-33', 'saadi town', 'malir cantt', 'mehran university'
            ];
            if (sindhCities.some(city => loc.includes(city))) return 'Sindh';
            
            // Balochistan cities - comprehensive list
            const balochistanCities = [
                'quetta', 'gwadar', 'turbat', 'sibi', 'ziarat', 'loralai', 'chaman', 'qilla saifullah', 'pishin', 'kuchlak', 'dera murad jamali', 'sui', 'dera bugti', 'kohlu', 'barkhan', 'fort monroe', 'shaheen hotel', 'khuzdar', 'mastung', 'kalat', 'zhob', 'nushki', 'chagai', 'washuk', 'panjgur', 'kech', 'lasbela', 'jhal magsi', 'nasirabad', 'jaffarabad', 'dera allah yar',
                // Additional specific locations from unknown list
                'harnai', 'basti sheikan', 'khawasam', 'ahmedwal'
            ];
            if (balochistanCities.some(city => loc.includes(city))) return 'Balochistan';
            
            // AJK cities - comprehensive list
            const ajkCities = [
                'muzaffarabad', 'mirpur', 'rawalakot', 'bagh', 'bhimber', 'kotli', 'pallandri', 'haveli', 'sudhanoti', 'poonch', 'hattian', 'neelum', 'azad kashmir',
                // Additional specific locations from unknown list
                'dadyal', 'sarsala', 'samahani', 'mang'
            ];
            if (ajkCities.some(city => loc.includes(city))) return 'AJK';
            
            // GB cities - comprehensive list
            const gbCities = [
                'gilgit', 'skardu', 'hunza', 'nagar', 'chilas', 'ghizer', 'diamer', 'astor', 'ghanche', 'shigar', 'shimshal', 'baltistan', 'astore', 'kharmang',
                // Additional specific locations
                'garlat', 'chach valley', 'waisa'
            ];
            if (gbCities.some(city => loc.includes(city))) return 'GB';
            
            // Default to unknown if no match
            return '';
        }

        const provinceCounts = {};
        const unknownStations = [];

        stations.forEach(s => {
            const loc = s.location || s.station_name || '';
            const prov = determineProvince(loc);
            if (!prov) {
                unknownStations.push({id: s.station_id, loc: loc});
            }
            provinceCounts[prov || 'Unknown'] = (provinceCounts[prov || 'Unknown'] || 0) + 1;
        });

        console.log('\nProvince Counts:');
        Object.entries(provinceCounts).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => console.log(k + ': ' + v));
        console.log('\nTotal stations:', stations.length);
        console.log('\nUnknown locations (' + unknownStations.length + '):');
        unknownStations.forEach(s => console.log('  ' + s.id + ': ' + s.loc));
    });
});
